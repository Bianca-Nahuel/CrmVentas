import { Global, Module } from '@nestjs/common';
import { parseEnv, type Env } from './env.js';

export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => parseEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
