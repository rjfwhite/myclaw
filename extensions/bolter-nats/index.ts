import { BolterNatsChannel } from './src/channel.js';

export default {
  id: 'bolter-nats',
  name: 'Bolter NATS Channel',
  description: 'Connects OpenClaw to the Bolter platform via NATS message bus',

  register(api: any) {
    const channel = new BolterNatsChannel();
    api.registerChannel({ plugin: channel });
  },
};
