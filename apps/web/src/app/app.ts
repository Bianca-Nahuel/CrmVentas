import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toast } from './ui/toast';
import { ThemeService } from './ui/theme.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Toast],
  template: `
    <router-outlet />
    <app-toast />
  `,
})
export class App {
  constructor() {
    // Aplica el tema elegido y escucha los cambios del sistema.
    inject(ThemeService);
  }
}
