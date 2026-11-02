import type { Routes } from '@angular/router';
import { AgentPage } from './agent/agent-page';
import { BusinessSection } from './agent/sections/business-section';
import { GeneralSection } from './agent/sections/general-section';
import { HandoffSection } from './agent/sections/handoff-section';
import { HistorySection } from './agent/sections/history-section';
import { InboxSection } from './agent/sections/inbox-section';
import { KnowledgeSection } from './agent/sections/knowledge-section';
import { PersonalitySection } from './agent/sections/personality-section';
import { QualificationSection } from './agent/sections/qualification-section';
import { ScoringSection } from './agent/sections/scoring-section';

// Configuración del agente (tarea 027) en su propio módulo lazy: arrastra el zod de la config (subpath
// @ventas/shared/ai), que no tiene que entrar en el bundle inicial. Una ruta hija por sección, todas sobre el
// mismo borrador; el guard de salida avisa si quedan cambios sin guardar.
export const AGENT_ROUTES: Routes = [
  {
    path: '',
    component: AgentPage,
    canDeactivate: [(page: AgentPage) => page.canLeave()],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'general' },
      { path: 'general', title: 'Agente · General', component: GeneralSection },
      { path: 'negocio', title: 'Agente · Negocio', component: BusinessSection },
      { path: 'conocimiento', title: 'Agente · Conocimiento', component: KnowledgeSection },
      { path: 'personalidad', title: 'Agente · Personalidad y reglas', component: PersonalitySection },
      { path: 'calificacion', title: 'Agente · Calificación', component: QualificationSection },
      { path: 'puntaje', title: 'Agente · Puntaje', component: ScoringSection },
      { path: 'derivacion', title: 'Agente · Derivación', component: HandoffSection },
      { path: 'bandeja', title: 'Agente · Bandeja y revisión', component: InboxSection },
      { path: 'historial', title: 'Agente · Historial', component: HistorySection },
    ],
  },
];
