import { app } from './app';
import type { GymEnv } from './env';
import { runCron } from './house';

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: GymEnv, ctx: ExecutionContext) {
    await runCron(env, ctx, controller.scheduledTime);
  },
} satisfies ExportedHandler<GymEnv>;
