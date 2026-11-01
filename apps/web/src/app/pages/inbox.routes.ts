import type { Routes } from '@angular/router';
import { ChannelMembersPage } from './channels/channel-members-page';
import { ConversationEmpty } from './inbox/conversation-empty';
import { ConversationPage } from './inbox/conversation-page';
import { InboxPage } from './inbox/inbox-page';
import { LeadsPage } from './leads/leads-page';

// Leads, bandeja y números (tarea 014) en UN módulo lazy: si cada página fuera su propio chunk, el build
// junta el código que comparten (tabla, íconos, cliente de la API) en un chunk que carga el bundle
// inicial. Así queda todo en un solo chunk que se baja al entrar a cualquiera de las tres.

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

export const CHANNEL_MEMBERS_ROUTES: Routes = [{ path: '', component: ChannelMembersPage }];
