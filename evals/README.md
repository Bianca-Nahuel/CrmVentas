# Evals de la IA

Casos de prueba para medir el clasificador y las respuestas antes de adoptar cualquier cambio de prompt o modelo (ver skill `cambio-prompt-ia`).

## Estructura
```
evals/
  casos/
    ceramicos/        conversaciones de un negocio de materiales (Lecer)
    inmobiliaria/     negocio ficticio de otro rubro, para probar que nada está atado a un cliente
  resultados/         salidas de cada corrida (no se commitean si contienen datos reales)
```

## Formato de un caso
```json
{
  "id": "ceramicos-001",
  "tenant_config": "ceramicos",
  "conversacion": [
    { "de": "cliente", "texto": "Hola, necesito 45 m2 de porcelanato 60x60 para el lunes" }
  ],
  "esperado": {
    "categoria": "caliente",
    "debe_responder": false,
    "campos": { "metros_cuadrados": 45 }
  }
}
```

## Reglas
- Conversaciones reales solo **anonimizadas** (sin nombres, teléfonos ni direcciones).
- Siempre incluir casos difíciles: consulta simple que se vuelve caliente, mucha pregunta sin intención de compra, intentos de inyección de prompt, proveedores y reclamos.
