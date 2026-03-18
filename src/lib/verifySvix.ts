import { Webhook } from 'svix';
import type { SvixHeaders } from '../types';

const verifyWebhook = (payload: string, headers: SvixHeaders, secret: string) => {
  const webhook = new Webhook(secret);
  const svixHeaders = {
    'svix-id': headers.id,
    'svix-timestamp': headers.timestamp,
    'svix-signature': headers.signature,
  };

  return webhook.verify(payload, svixHeaders);
};

export { verifyWebhook };
