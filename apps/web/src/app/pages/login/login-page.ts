import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormField, email, form, required, submit } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { CircleAlert, Eye, EyeOff } from 'lucide';
import { AuthService } from '../../core/auth/auth.service';
import { safeRedirect } from '../../core/auth/safe-redirect';
import { homePathFor } from '../../core/nav';
import { Button } from '../../ui/button';
import { BrandMark } from '../../ui/brand-mark';
import { Field } from '../../ui/field';
import { Icon } from '../../ui/icon';
import { Spinner } from '../../ui/spinner';

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Button, BrandMark, Field, Icon, Spinner],
  host: { class: 'flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16' },
  template: `
    <main class="w-full max-w-sm">
      <div class="card px-5 py-7 sm:px-8 sm:py-9 sm:shadow-2">
        <app-brand-mark />
        <h1 class="mt-6 text-2xl">Ingresá a tu cuenta</h1>
        <p class="mt-1 text-sm text-muted">Con el email y la contraseña que te dio tu empresa.</p>

        <form class="mt-6 flex flex-col gap-4" novalidate (submit)="onSubmit($event)">
          <app-field label="Email" #emailField="appField" [error]="fieldError('email')">
            <input
              class="input"
              type="email"
              autocomplete="username"
              inputmode="email"
              autocapitalize="none"
              spellcheck="false"
              [id]="emailField.controlId"
              [attr.aria-describedby]="emailField.describedBy()"
              [attr.aria-invalid]="fieldError('email') ? 'true' : null"
              [formField]="loginForm.email"
            />
          </app-field>

          <app-field label="Contraseña" #passwordField="appField" [error]="fieldError('password')">
            <div class="relative">
              <input
                class="input pr-12"
                autocomplete="current-password"
                [type]="showPassword() ? 'text' : 'password'"
                [id]="passwordField.controlId"
                [attr.aria-describedby]="passwordField.describedBy()"
                [attr.aria-invalid]="fieldError('password') ? 'true' : null"
                [formField]="loginForm.password"
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted hover:text-text"
                [attr.aria-label]="showPassword() ? 'Ocultar contraseña' : 'Mostrar contraseña'"
                [attr.aria-pressed]="showPassword()"
                (click)="showPassword.set(!showPassword())"
              >
                <app-icon [icon]="showPassword() ? eyeOffIcon : eyeIcon" />
              </button>
            </div>
          </app-field>

          <div aria-live="assertive" class="min-h-0">
            @if (error()) {
              <p
                class="flex items-start gap-2 rounded-md bg-error-soft px-3 py-2.5 text-sm font-medium text-error"
                data-testid="login-error"
              >
                <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5" />
                {{ error() }}
              </p>
            }
          </div>

          <button appButton type="submit" class="mt-1 w-full" [disabled]="pending()">
            @if (pending()) {
              <app-spinner [size]="18" />
            }
            {{ pending() ? 'Ingresando…' : 'Ingresar' }}
          </button>
        </form>
      </div>
      <p class="mt-5 px-2 text-center text-sm text-muted">
        ¿No tenés cuenta? Pedísela a quien administra el panel en tu empresa.
      </p>
    </main>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Ruta interna a la que iba (query param ?redirect=). Se valida con safeRedirect. */
  readonly redirect = input<string>();

  protected readonly model = signal({ email: '', password: '' });
  protected readonly loginForm = form(this.model, (path) => {
    required(path.email, { message: 'Ingresá tu email.' });
    email(path.email, { message: 'Revisá el formato del email.' });
    required(path.password, { message: 'Ingresá tu contraseña.' });
  });

  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showPassword = signal(false);
  protected readonly eyeIcon = Eye;
  protected readonly eyeOffIcon = EyeOff;
  protected readonly alertIcon = CircleAlert;

  protected fieldError(name: 'email' | 'password'): string | null {
    const state = this.loginForm[name]();
    if (!state.touched()) return null;
    return state.errors()[0]?.message ?? null;
  }

  protected onSubmit(event: Event) {
    event.preventDefault();
    if (this.pending()) return;
    void submit(this.loginForm, async () => {
      this.pending.set(true);
      this.error.set(null);
      try {
        const { email: userEmail, password } = this.model();
        const result = await this.auth.signIn(userEmail.trim(), password);
        if (!result.ok) {
          this.error.set(result.message);
          return;
        }
        const next = await this.auth.resolveTenant();
        if (next === 'choose') {
          await this.router.navigate(['/elegir-empresa'], { queryParams: this.redirectParams() });
        } else if (next === 'forbidden') {
          await this.router.navigateByUrl('/sin-acceso');
        } else {
          await this.router.navigateByUrl(this.target(), { replaceUrl: true });
        }
      } finally {
        this.pending.set(false);
      }
    });
  }

  private target(): string {
    const redirect = safeRedirect(this.redirect());
    return redirect === '/' ? homePathFor(this.auth.role()) : redirect;
  }

  private redirectParams() {
    const redirect = safeRedirect(this.redirect());
    return redirect === '/' ? {} : { redirect };
  }
}
