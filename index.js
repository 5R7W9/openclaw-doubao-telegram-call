import {
  createTelegramCallRuntime,
} from './src/telegram-call/runtime.js';
import {
  PLUGIN_ID,
} from './src/telegram-call/constants.js';
import {
  registerTelegramCallRoutes,
  resolvePluginConfig,
} from './src/telegram-call/routes.js';
import {
  registerTelegramCallTools,
} from './src/telegram-call/tools.js';

export default {
  id: PLUGIN_ID,
  name: 'Doubao Telegram Call',
  description: 'Telegram Mini App realtime phone companion for OpenClaw Talk.',
  register(api) {
    const runtime = createTelegramCallRuntime({
      config: resolvePluginConfig(api),
    });
    registerTelegramCallRoutes(api, { runtime });
    registerTelegramCallTools(api, { runtime });
  },
};

export {
  createTelegramCallRuntime,
} from './src/telegram-call/runtime.js';
export {
  registerTelegramCallRoutes,
} from './src/telegram-call/routes.js';
export {
  registerTelegramCallTools,
} from './src/telegram-call/tools.js';
