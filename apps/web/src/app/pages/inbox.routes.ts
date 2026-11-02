import type { Routes } from '@angular/router';
import { ChannelsPage } from './channels/channels-page';
import { ConversationEmpty } from './inbox/conversation-empty';
import { ConversationPage } from './inbox/conversation-page';
import { InboxPage } from './inbox/inbox-page';
import { LeadsPage } from './leads/leads-page';

// Leads, bandeja, números (tarea 014) y canales (011) en UN módulo lazy: si cada página fuera su propio chunk, el build
// junta el código que comparten (tabla, íconos, cliente de la API) en un chunk que carga el bundle
// inicial. Así queda todo en un solo chunk que se baja al entrar a cualquiera de ellas.

export const LEADS_ROUTES: Routes = [{ path: '', component: LeadsPage }];

export const INBOX_ROUTES: Routes = [
  {
    path: '',
    component: InboxPage,
    children: [
      { path: '', component: ConversationEmpty },
      { path: ':id', title: 'Conversación', component: ConversationPage },
    ],
  },
];

// Números: conexión (011) y vendedores de cada número (014) en una sola página.
export const CHANNELS_ROUTES: Routes = [{ path: '', component: ChannelsPage }];
