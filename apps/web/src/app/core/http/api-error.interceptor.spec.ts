import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { NotifyService } from '../../ui/toast';
import { AuthService } from '../auth/auth.service';
import { apiErrorInterceptor } from './api-error.interceptor';
import { skipApiErrorHandling } from './http-context';

describe('apiErrorInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let router: Router;
  const auth = { reset: vi.fn() };
  const notify = { networkError: vi.fn() };

  beforeEach(() => {
    auth.reset.mockReset();
    notify.networkError.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: auth },
        { provide: NotifyService, useValue: notify },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => controller.verify());

  async function failWith(status: number, body: object = {}) {
    const request = firstValueFrom(http.get('/api/algo'));
    const pending = controller.expectOne('/api/algo');
    if (status === 0) pending.error(new ProgressEvent('error'));
    else pending.flush(body, { status, statusText: 'x' });
    await expect(request).rejects.toBeTruthy();
  }

  it('401 → limpia la sesión y va al login', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await failWith(401);
    expect(auth.reset).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/ingresar'], expect.anything());
  });

  it('403 sin empresa activa → elegir empresa; otro 403 → sin acceso', async () => {
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await failWith(403, { code: 'NO_ACTIVE_TENANT' });
    expect(navigate).toHaveBeenLastCalledWith('/elegir-empresa');
    await failWith(403, { code: 'MEMBERSHIP_INACTIVE' });
    expect(navigate).toHaveBeenLastCalledWith('/sin-acceso');
  });

  it('error de red → aviso no intrusivo, sin navegar', async () => {
    const navigate = vi.spyOn(router, 'navigateByUrl');
    await failWith(0);
    expect(notify.networkError).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('otros errores (500) solo se propagan', async () => {
    const navigate = vi.spyOn(router, 'navigateByUrl');
    await failWith(500);
    expect(navigate).not.toHaveBeenCalled();
    expect(notify.networkError).not.toHaveBeenCalled();
  });

  it('los pedidos marcados para manejar sus errores no redirigen', async () => {
    const navigate = vi.spyOn(router, 'navigate');
    const request = firstValueFrom(http.get('/api/me/context', skipApiErrorHandling()));
    controller.expectOne('/api/me/context').flush({}, { status: 401, statusText: 'x' });
    await expect(request).rejects.toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.reset).not.toHaveBeenCalled();
  });
});
