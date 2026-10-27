// Catálogo contra el Postgres local (tarea 007): importación con vista previa, aplicar y volver atrás
// (verificación 1), aislamiento entre empresas y permisos (9), búsqueda con sinónimos, sin tildes y con
// errores de tipeo, filtro y orden por precio (6), caché (5) y un turno completo del agente que consulta el
// catálogo, cita un precio con marca y deja el registro en ai_runs (7, ajuste 3). Datos inventados.
import { Logger } from '@nestjs/common';
import type { TenantConfigInput } from '@ventas/shared';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantConfigService, InvalidTenantConfigError } from '../src/ai/config/tenant-config.service.js';
import { NoopBudgetGuard } from '../src/ai/llm/budget-guard.js';
import type { LlmRequest } from '../src/ai/llm/llm-client.js';
import type { AgentOutput } from '../src/ai/prompts/v2/output-schema.js';
import { AiReplyService } from '../src/ai/reply/ai-reply.service.js';
import { CatalogRefreshWorker } from '../src/catalog/catalog-refresh.worker.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { CatalogViewer } from '../src/catalog/catalog-viewer.js';
import { CatalogImportError, CatalogImportService } from '../src/catalog/import/catalog-import.service.js';
import { PgCatalogStore } from '../src/catalog/pg-catalog-store.js';
import { ProductPageReader } from '../src/catalog/web/product-page-reader.js';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import { OutboundService } from '../src/messaging/outbound/outbound.service.js';
import type { PresenceService } from '../src/messaging/outbound/presence.service.js';
import {
  addMessage,
  agentOutput,
  FakeLlm,
  FakeLlmFactory,
  FakePresence,
  signals,
  testConfigInput,
} from './ai-helpers.js';
import { buildXlsx, catalogConfig, FakeFetcher, html, SHOP } from './catalog-helpers.js';
import { asApp, errorCodeIn, startTestContext, withTenant, type TestContext } from './helpers.js';
import { createChannelTenant, createChat, uid } from './outbound-helpers.js';

const PERMISSION_DENIED = '42501';
const HEADER = [
  'Código',
  'Descripción',
  'Rubro',
  'Unidad',
  'M2 x caja',
  'Precio',
  'Link',
  'Color',
  'Formato',
];
const url = (sku: string) => `https://www.${SHOP}/p/${sku.toLowerCase()}`;

let ctx: TestContext;
let db: AppDatabase;
const importer = new CatalogImportService();
const configs = new TenantConfigService();
const logged: string[] = [];

beforeAll(async () => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
  ctx = await startTestContext();
  const boss = ctx.app.get<PgBoss>(BOSS);
  await boss.offWork(QUEUES.aiReply);
  await boss.offWork(QUEUES.whatsappOutbound);
  await boss.offWork(QUEUES.catalogRefresh);
  db = ctx.app.get<AppDatabase>(APP_DB);
});

afterAll(async () => {
  await ctx?.close();
  vi.restoreAllMocks();
});

const tx = <T>(tenantId: string, fn: Parameters<typeof withTenantTransaction<T>>[2]) =>
  withTenantTransaction(db.db, { tenantId }, fn);

async function newTenant() {
  const channel = await createChannelTenant(ctx, uid().slice(0, 8));
  return channel;
}

function preview(
  tenantId: string,
  rows: (string | number | null)[][],
  mapping?: unknown,
  catalog = catalogConfig(),
) {
  return tx(tenantId, (t) =>
    importer.preview(t, {
      fileName: '../../etc/lista precios.xlsx',
      data: buildXlsx(rows),
      catalog,
      ...(mapping ? { mapping } : {}),
    }),
  );
}

async function products(tenantId: string) {
  return asApp(ctx, { tenantId }, async (c) => {
    const { rows } = await c.query(
      'SELECT sku, name, active, attributes, units_per_package::text AS upp FROM catalog_products ORDER BY sku',
    );
    return rows as {
      sku: string;
      name: string;
      active: boolean;
      attributes: Record<string, unknown>;
      upp: string;
    }[];
  });
}

const FIRST = [
  HEADER,
  [
    'CER-001',
    'Cerámica Símil Madera Roble 45x45',
    'Cerámicos',
    'm2',
    2.02,
    37290,
    url('CER-001'),
    'roble',
    '45x45',
  ],
  [
    'POR-010',
    'Porcelanato Nórdico Gris 60x60',
    'Porcelanatos',
    'm²',
    '1,44',
    '18.500',
    url('POR-010'),
    'gris',
    '60x60',
  ],
  ['PEG-100', 'Pegamento para porcelanato 30 kg', 'Adhesivos', 'u', null, 9800, null, null, null],
  ['MAR-001', 'Mármol Travertino', 'Mármoles', 'm2', 1, 90000, null, 'beige', null],
];

describe('1. importación del Excel', () => {
  let tenantId: string;
  let firstId: string;

  beforeAll(async () => {
    tenantId = (await newTenant()).tenantId;
  });

  it('vista previa: todo nuevo, columnas extra en attributes, sin tocar el catálogo', async () => {
    const result = await preview(tenantId, FIRST);
    firstId = result.importId;
    expect(result.mappingSource).toBe('proposed');
    expect(result.counts).toEqual({
      rows: 4,
      invalid: 0,
      new: 4,
      changed: 0,
      unchanged: 0,
      missing: 0,
      priceJumps: 0,
    });
    expect(result.attributeKeys.sort()).toEqual(['color', 'formato']);
    expect(await products(tenantId)).toEqual([]);
    const { rows } = await ctx.ownerPool.query(
      'SELECT file_name, status, mapping FROM catalog_imports WHERE id = $1',
      [firstId],
    );
    expect(rows[0]).toMatchObject({ file_name: 'lista precios.xlsx', status: 'preview' });
  });

  it('aplicar: productos con attributes y snapshots del Excel', async () => {
    expect(await tx(tenantId, (t) => importer.apply(t, firstId))).toEqual({
      upserted: 4,
      deactivated: 0,
      snapshots: 4,
    });
    const list = await products(tenantId);
    expect(list.map((p) => [p.sku, p.active, p.upp])).toEqual([
      ['CER-001', true, '2.0200'],
      ['MAR-001', true, '1.0000'],
      ['PEG-100', true, null],
      ['POR-010', true, '1.4400'],
    ]);
    expect(list.find((p) => p.sku === 'CER-001')!.attributes).toEqual({ color: 'roble', formato: '45x45' });
    await expect(tx(tenantId, (t) => importer.apply(t, firstId))).rejects.toBeInstanceOf(CatalogImportError);
  });

  it('segunda vista previa: cambiados (con qué cambió), sin cambios, ausentes, salto de precio y filas inválidas', async () => {
    const result = await preview(
      tenantId,
      [
        HEADER,
        [
          'CER-001',
          'Cerámica Símil Madera Roble 45x45',
          'Cerámicos',
          'm2',
          2.02,
          37290,
          url('CER-001'),
          'roble',
          '45x45',
        ],
        [
          'POR-010',
          'Porcelanato Nórdico Gris 60x60 Rectificado',
          'Porcelanatos',
          'm2',
          1.44,
          30000,
          url('POR-010'),
          'gris',
          '60x60',
        ],
        ['NEW-001', 'Pastina gris 5 kg', 'Pastinas', 'u', null, 3500, null, null, null],
        ['NEW-001', 'Repetido', null, null, null, null, null, null, null],
        ['OTR-001', 'Otro dominio', null, null, null, null, 'https://otra-tienda.test/x', null, null],
        ['WWW-001', 'Sin www', null, null, null, null, `https://${SHOP}/x`, null, null],
        ['MAR-001', 'Mármol Travertino', 'Mármoles', 'm2', '2.02', 90000, null, 'beige', null],
      ],
      undefined,
      catalogConfig({ allowed_domains: [`www.${SHOP}`] }),
    );
    expect(result.mappingSource).toBe('saved');
    expect(result.counts).toMatchObject({
      new: 0,
      changed: 1,
      unchanged: 1,
      missing: 1,
      invalid: 5,
      priceJumps: 1,
    });
    expect(result.changes.find((c) => c.sku === 'POR-010')).toMatchObject({
      change: 'changed',
      priceJump: true,
      fields: {
        name: ['Porcelanato Nórdico Gris 60x60', 'Porcelanato Nórdico Gris 60x60 Rectificado'],
        price: ['18500', '30000'],
      },
    });
    expect(result.missing).toEqual(['PEG-100']);
    const errors = Object.fromEntries(result.invalid.map((row) => [row.sku, row.errors]));
    expect(errors).toEqual({
      'NEW-001': ['duplicate_sku'],
      'OTR-001': ['url_domain'],
      'WWW-001': ['url_domain_www_variant'],
      'MAR-001': ['bad_number:units_per_package'],
    });
  });

  it('aplicar: los ausentes quedan inactivos (no se borran); una fila inválida no desactiva su producto', async () => {
    const result = await preview(tenantId, [
      HEADER,
      [
        'CER-001',
        'Cerámica Símil Madera Roble 45x45',
        'Cerámicos',
        'm2',
        2.02,
        37290,
        url('CER-001'),
        'roble',
        '45x45',
      ],
      [
        'POR-010',
        'Porcelanato Nórdico Gris 60x60 Rectificado',
        'Porcelanatos',
        'm2',
        1.44,
        19000,
        url('POR-010'),
        'gris',
        '60x60',
      ],
      ['MAR-001', 'Mármol Travertino', 'Mármoles', 'm2', '2.02', 90000, null, 'beige', null],
    ]);
    await tx(tenantId, (t) => importer.apply(t, result.importId));
    const list = await products(tenantId);
    expect(list.map((p) => [p.sku, p.active])).toEqual([
      ['CER-001', true],
      ['MAR-001', true],
      ['PEG-100', false],
      ['POR-010', true],
    ]);
    expect(list.find((p) => p.sku === 'POR-010')!.name).toMatch(/Rectificado/);
  });

  it('volver atrás: reaplica la importación anterior', async () => {
    const reverted = await tx(tenantId, (t) => importer.revert(t));
    expect(reverted.restoredId).toBe(firstId);
    const list = await products(tenantId);
    expect(list.map((p) => [p.sku, p.active])).toEqual([
      ['CER-001', true],
      ['MAR-001', true],
      ['PEG-100', true],
      ['POR-010', true],
    ]);
    expect(list.find((p) => p.sku === 'POR-010')!.name).toBe('Porcelanato Nórdico Gris 60x60');
    const { rows } = await ctx.ownerPool.query(
      "SELECT count(*)::int AS n FROM catalog_imports WHERE tenant_id = $1 AND status = 'reverted'",
      [tenantId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('una vista previa vieja no se aplica si se aplicó otra después', async () => {
    const stale = await preview(tenantId, FIRST);
    const fresh = await preview(tenantId, FIRST);
    await tx(tenantId, (t) => importer.apply(t, fresh.importId));
    await expect(tx(tenantId, (t) => importer.apply(t, stale.importId))).rejects.toMatchObject({
      code: 'stale_preview',
    });
  });

  it('una importación sin ninguna fila válida no se aplica (no desactiva todo el catálogo)', async () => {
    const empty = await preview(tenantId, [
      HEADER,
      ['MAL 1', 'Con espacio', null, null, null, null, null, null, null],
    ]);
    await expect(tx(tenantId, (t) => importer.apply(t, empty.importId))).rejects.toMatchObject({
      code: 'no_valid_rows',
    });
    expect((await products(tenantId)).every((product) => product.active)).toBe(true);
  });

  it('archivo .csv → error claro; columnas del mapeo que no están → error', async () => {
    await expect(
      tx(tenantId, (t) =>
        importer.preview(t, {
          fileName: 'x.csv',
          data: Buffer.from('sku;nombre\nA;B\n'),
          catalog: catalogConfig(),
        }),
      ),
    ).rejects.toThrow(/guardalo como \.xlsx/);
    await expect(preview(tenantId, FIRST, { columns: { sku: 'SKU', name: 'Nombre' } })).rejects.toMatchObject(
      {
        code: 'missing_columns',
      },
    );
  });
});

describe('9. aislamiento y permisos', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    a = (await newTenant()).tenantId;
    b = (await newTenant()).tenantId;
    const imported = await preview(a, FIRST);
    await tx(a, (t) => importer.apply(t, imported.importId));
  });

  it('la empresa B no ve productos, snapshots, importaciones ni filas de A', async () => {
    for (const table of ['catalog_products', 'product_snapshots', 'catalog_imports', 'catalog_import_rows']) {
      const count = (tenantId: string) =>
        asApp(
          ctx,
          { tenantId },
          async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
        );
      expect(await count(b)).toBe(0);
      expect(await count(a)).toBeGreaterThan(0);
      const noContext = await asApp(
        ctx,
        {},
        async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
      );
      expect(noContext).toBe(0);
    }
    const store = new PgCatalogStore(db.db, b);
    expect(await store.findProduct('CER-001')).toBeNull();
  });

  it('B no puede insertar en A ni modificar sus productos; nadie puede borrar', async () => {
    await asApp(ctx, { tenantId: b }, async (c) => {
      expect(
        await errorCodeIn(c, `INSERT INTO catalog_products (tenant_id, sku, name) VALUES ($1, 'X-1', 'x')`, [
          a,
        ]),
      ).toBe(PERMISSION_DENIED);
      const updated = await c.query(`UPDATE catalog_products SET name = 'pisado' WHERE sku = 'CER-001'`);
      expect(updated.rowCount).toBe(0);
    });
    await asApp(ctx, { tenantId: a }, async (c) => {
      for (const table of [
        'catalog_products',
        'product_snapshots',
        'catalog_imports',
        'catalog_import_rows',
      ]) {
        expect(await errorCodeIn(c, `DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
      }
      expect(await errorCodeIn(c, `UPDATE catalog_products SET sku = 'otro'`)).toBe(PERMISSION_DENIED);
      expect(await errorCodeIn(c, `UPDATE product_snapshots SET ok = false`)).toBe(PERMISSION_DENIED);
      expect(await errorCodeIn(c, `DROP TABLE catalog_products`)).toBe(PERMISSION_DENIED);
    });
  });

  it('un snapshot de A no puede apuntar a un producto de otra empresa (FK compuesta)', async () => {
    const productOfA = await asApp(
      ctx,
      { tenantId: a },
      async (c) => (await c.query('SELECT id FROM catalog_products LIMIT 1')).rows[0].id,
    );
    await withTenant(ctx, b, async (c) => {
      const code = await errorCodeIn(
        c,
        `INSERT INTO product_snapshots (tenant_id, product_id, source, ok) VALUES ($1, $2, 'web', true)`,
        [b, productOfA],
      );
      expect(code).toBe('23503');
    });
  });
});

describe('6. búsqueda en Postgres', () => {
  let tenantId: string;
  let store: PgCatalogStore;
  const search = (
    terms: string[],
    text: string,
    extra: Partial<Parameters<PgCatalogStore['search']>[0]> = {},
  ) =>
    store.search({
      terms,
      text,
      limit: 5,
      maxPrice: null,
      order: 'relevance',
      priceSources: ['excel'],
      usePromo: false,
      ...extra,
    });

  beforeAll(async () => {
    tenantId = (await newTenant()).tenantId;
    const imported = await preview(tenantId, FIRST);
    await tx(tenantId, (t) => importer.apply(t, imported.importId));
    store = new PgCatalogStore(db.db, tenantId);
  });

  it('sin tildes, por atributos, con sinónimos y con errores de tipeo', async () => {
    expect((await search(['ceramica', 'simil'], 'ceramica simil'))[0]!.product.sku).toBe('CER-001');
    expect((await search(['gris'], 'gris'))[0]!.product.sku).toBe('POR-010');
    expect((await search(['piso', 'porcelanato', 'ceramica'], 'piso')).map((h) => h.product.sku)).toEqual(
      expect.arrayContaining(['POR-010', 'CER-001']),
    );
    expect((await search(['porselanato', 'nordico'], 'porselanato nordico'))[0]!.product.sku).toBe('POR-010');
    expect(await search(['inexistente'], 'inexistente')).toEqual([]);
  });

  it('precio_max y orden por precio (con el precio del Excel)', async () => {
    const all = ['porcelanato', 'ceramica', 'pegamento', 'marmol'];
    const cheap = await search(all, 'x', { maxPrice: '20000' });
    expect(cheap.map((h) => h.product.sku).sort()).toEqual(['PEG-100', 'POR-010']);
    const asc = await search(all, 'x', { order: 'price_asc' });
    expect(asc.map((h) => h.product.sku)).toEqual(['PEG-100', 'POR-010', 'CER-001', 'MAR-001']);
    const desc = await search(all, 'x', { order: 'price_desc' });
    expect(desc[0]!.product.sku).toBe('MAR-001');
    expect(asc[0]!.priceReadAt).toBeInstanceOf(Date);
  });

  it('5. caché: dos consultas seguidas → una sola lectura de la página', async () => {
    const fetcher = new FakeFetcher().page(url('CER-001'), html('producto-ceramicos.html'));
    const viewer = new CatalogViewer(new ProductPageReader(fetcher));
    const catalog = catalogConfig();
    const first = await viewer.view(store, catalog, 'CER-001');
    const second = await viewer.view(store, catalog, 'CER-001');
    expect(fetcher.calls).toHaveLength(1);
    expect(first!.price).toMatchObject({ source: 'web', current: true });
    expect(second!.price!.snapshot.id).toBe(first!.price!.snapshot.id);
    expect(second!.price!.snapshot.listPrice).toBe('37290');
  });

  it('3. cordura: un salto de precio no se usa, queda el anterior y se registra el aviso', async () => {
    const catalog = catalogConfig({ max_price_age_minutes: 5 });
    const product = (await store.findProduct('CER-001'))!;
    const later = () => new Date(Date.now() + 3_600_000);
    const fetcher = new FakeFetcher().page(
      url('CER-001'),
      html('producto-ceramicos.html').replace('$37.290', '$95.000'),
    );
    const result = await new ProductPageReader(fetcher, later).read(store, catalog, product);
    expect(result).toMatchObject({ fetched: true, errorCode: 'price_jump' });
    expect(result.snapshot!.listPrice).toBe('37290');
    expect(logged.some((line) => line.includes('catalog-read') && line.includes('price_jump'))).toBe(true);
    const { rows } = await ctx.ownerPool.query(
      "SELECT ok, error_code FROM product_snapshots WHERE product_id = $1 AND source = 'web' ORDER BY read_at",
      [product.id],
    );
    expect(rows.map((r) => [r.ok, r.error_code])).toEqual([
      [true, null],
      [false, 'price_jump'],
    ]);
  });

  it('la config rechaza un selector CSS inválido', async () => {
    const input = testConfigInput([], {
      catalog: { ...catalogConfig(), extractor: { fields: { list_price: { selector: 'div[[' } } } },
    } as never);
    await expect(tx(tenantId, (t) => configs.insertVersion(t, input))).rejects.toBeInstanceOf(
      InvalidTenantConfigError,
    );
  });
});

describe('7. turno del agente con catálogo', () => {
  const fake = new FakeLlm();
  const fetcher = new FakeFetcher();

  class TestCatalogService extends CatalogService {
    override readonly reader = new ProductPageReader(fetcher);
    override readonly viewer = new CatalogViewer(this.reader);
  }

  function service() {
    return new AiReplyService(
      { ...ctx.env, AI_ENABLED: true },
      db,
      new FakeLlmFactory(fake),
      new NoopBudgetGuard(),
      configs,
      ctx.app.get(OutboundService),
      new FakePresence() as unknown as PresenceService,
      new TestCatalogService(db),
      ctx.app.get(CatalogRefreshWorker),
    );
  }

  async function setupChat(catalogOverrides: Parameters<typeof catalogConfig>[0] = {}) {
    const channel = await newTenant();
    const chat = await createChat(ctx, channel);
    const catalog = catalogConfig(catalogOverrides);
    const input: TenantConfigInput = { ...testConfigInput([chat.channelId]), catalog } as TenantConfigInput;
    await tx(chat.tenantId, (t) => configs.insertVersion(t, input));
    const imported = await preview(chat.tenantId, FIRST);
    await tx(chat.tenantId, (t) => importer.apply(t, imported.importId));
    fetcher.page(url('CER-001'), html('producto-ceramicos.html'));
    return {
      chat,
      config: (await tx(chat.tenantId, (t) => configs.latest(t))) as unknown as { kind: 'ok'; config: never },
    };
  }

  /** El modelo falso consulta las herramientas como lo haría uno real y responde con marcas. */
  function modelThatQuotes(reply: string, extraTools: { name: string; args: unknown }[] = []) {
    fake.respond = async (request: LlmRequest<AgentOutput>) => {
      const run = async (name: string, args: unknown) => {
        const tool = request.tools!.find((candidate) => candidate.name === name)!;
        return tool.execute(tool.args.parse(args));
      };
      await run('buscar_productos', { query: 'ceramica roble' });
      await run('ver_producto', { sku: 'CER-001' });
      for (const extra of extraTools) await run(extra.name, extra.args);
      const config = (await tx(currentTenant, (t) => configs.latest(t))) as unknown as { config: never };
      return agentOutput(config.config, { signals: signals(config.config, 1), action: 'reply', reply });
    };
  }
  let currentTenant = '';

  it('cita el precio con marca: se envía renderizado y ai_runs registra producto, snapshot y fuente', async () => {
    const { chat } = await setupChat();
    currentTenant = chat.tenantId;
    const messageId = await addMessage(ctx, chat, { text: '¿Cuánto sale la cerámica roble? Necesito 45 m2' });
    modelThatQuotes('La Roble 45x45 está a {{precio:CER-001:lista}}. Para 45 m² son {{cajas:CER-001:45}}.', [
      { name: 'calcular_cantidad', args: { sku: 'CER-001', cantidad: 45, unidad: 'm2' } },
    ]);
    const outcome = await service().process({
      tenantId: chat.tenantId,
      conversationId: chat.conversationId,
      messageId,
    });
    expect(outcome.decision).toBe('replied');
    expect(fake.requests.at(-1)!.tools!.map((tool) => tool.name)).toEqual([
      'buscar_productos',
      'ver_producto',
      'calcular_cantidad',
    ]);
    const { rows: sent } = await ctx.ownerPool.query(
      'SELECT body FROM outbound_messages WHERE conversation_id = $1',
      [chat.conversationId],
    );
    expect(sent[0].body).toBe(
      'La Roble 45x45 está a $37.290 por m². Para 45 m² son 23 cajas (46,46 m²). Precio sujeto a cambios.',
    );
    const { rows } = await ctx.ownerPool.query(
      'SELECT prompt_version, catalog_citations FROM ai_runs WHERE conversation_id = $1',
      [chat.conversationId],
    );
    expect(rows[0].prompt_version).toBe('v2');
    const citations = rows[0].catalog_citations;
    expect(citations.consulted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'buscar_productos', sku: 'CER-001' }),
        expect.objectContaining({
          tool: 'ver_producto',
          sku: 'CER-001',
          price_source: 'web',
          snapshot_id: expect.any(String),
        }),
      ]),
    );
    expect(citations.cited).toEqual([
      expect.objectContaining({ kind: 'precio', sku: 'CER-001', price_type: 'lista', source: 'web' }),
      expect.objectContaining({ kind: 'cajas', sku: 'CER-001' }),
    ]);
    // Logs sin el texto del cliente ni el HTML.
    expect(logged.join('\n')).not.toMatch(/cerámica roble|price--list/);
  });

  it('price_source excel: el precio citado sale del Excel y queda registrado así', async () => {
    const { chat } = await setupChat({ price_source: 'excel' });
    currentTenant = chat.tenantId;
    const messageId = await addMessage(ctx, chat, { text: '¿Precio de la cerámica roble?' });
    modelThatQuotes('Está a {{precio:CER-001:lista}}.');
    const calls = fetcher.calls.length;
    await service().process({ tenantId: chat.tenantId, conversationId: chat.conversationId, messageId });
    expect(fetcher.calls.length).toBe(calls);
    const { rows } = await ctx.ownerPool.query(
      'SELECT catalog_citations FROM ai_runs WHERE conversation_id = $1',
      [chat.conversationId],
    );
    expect(rows[0].catalog_citations.cited).toEqual([
      expect.objectContaining({ kind: 'precio', source: 'excel' }),
    ]);
  });

  it('un monto escrito a mano o una marca de un producto no consultado → bloquea y deriva', async () => {
    const { chat } = await setupChat();
    currentTenant = chat.tenantId;
    const first = await addMessage(ctx, chat, { text: '¿Precio?' });
    modelThatQuotes('Está a $37.290 el m².');
    const outcome = await service().process({
      tenantId: chat.tenantId,
      conversationId: chat.conversationId,
      messageId: first,
    });
    expect(outcome.decision).toBe('blocked:money');
  });

  it('marca de un SKU que no se consultó en el turno → blocked:marker', async () => {
    const { chat } = await setupChat();
    currentTenant = chat.tenantId;
    const messageId = await addMessage(ctx, chat, { text: '¿Y el porcelanato?' });
    modelThatQuotes('El porcelanato está a {{precio:POR-010:lista}}.');
    const outcome = await service().process({
      tenantId: chat.tenantId,
      conversationId: chat.conversationId,
      messageId,
    });
    expect(outcome.decision).toBe('blocked:marker');
  });
});
