import 'dotenv/config';
import resend from '../services/resendClient';
import domainService from '../services/domainService';
import domainStore from '../stores/domainStore';

type ResendDomainRecord = {
  record?: string;
  name?: string;
  value?: string;
  ttl?: string | number;
  status?: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

const printRecords = (records: ResendDomainRecord[]) => {
  if (!records.length) {
    console.log('No DNS records returned by Resend.');
    return;
  }

  console.log('\nDNS records to add/update in Vercel:');
  for (const record of records) {
    const type = record.record || '';
    const name = record.name || '';
    const value = record.value || '';
    const ttl = record.ttl ?? '';
    const status = record.status || 'pending';
    console.log(`- ${type}  ${name}  ${value}  ttl=${ttl}  status=${status}`);
  }
};

const run = async () => {
  const defaultDomainName = process.env.DEFAULT_DOMAIN_NAME;
  const configuredDefaultDomainId = process.env.DEFAULT_DOMAIN_ID;

  if (!defaultDomainName) {
    throw new Error('DEFAULT_DOMAIN_NAME is required');
  }

  const { data: listData, error: listError } = await resend.domains.list();
  if (listError) {
    throw new Error(`Failed to list Resend domains: ${JSON.stringify(listError)}`);
  }

  const existing = (listData?.data || []).find(
    (domain: any) => normalize(domain.name) === normalize(defaultDomainName)
  );

  let domainId: string;
  if (existing?.id) {
    domainId = existing.id;
    console.log(`Found existing Resend domain: ${defaultDomainName} (${domainId})`);
  } else {
    const created = await domainService.createDomain({
      name: defaultDomainName,
      orgId: null,
    });

    if (created.error || !created.data?.id) {
      throw new Error(`Failed to create Resend domain: ${JSON.stringify(created.error || created.data)}`);
    }

    domainId = created.data.id;
    console.log(`Created Resend domain: ${defaultDomainName} (${domainId})`);
  }

  const { data: refreshData, error: refreshError } = await domainService.refreshDomainRecords(domainId);
  if (refreshError || !refreshData) {
    throw new Error(`Failed to refresh domain records: ${JSON.stringify(refreshError)}`);
  }

  await domainStore.upsertDomain({
    id: refreshData.id,
    name: refreshData.name,
    status: refreshData.status,
    region: refreshData.region,
    records: refreshData.records || [],
    createdAt: refreshData.created_at,
  });

  const webhook = await domainService.createInboundWebhook(domainId);
  if (webhook.error) {
    console.log(`Webhook setup skipped/failed: ${JSON.stringify(webhook.error)}`);
  } else {
    console.log('Inbound webhook is configured for the default domain.');
  }

  const stored = await domainStore.getDomain(domainId);
  console.log('\nStored default domain in DB:');
  console.log(`- id: ${stored?.id || domainId}`);
  console.log(`- name: ${stored?.name || defaultDomainName}`);
  console.log(`- status: ${stored?.status || refreshData.status || 'unknown'}`);

  printRecords((refreshData.records || []) as ResendDomainRecord[]);

  console.log('\nRequired backend env values:');
  console.log(`- DEFAULT_DOMAIN_NAME=${defaultDomainName}`);
  console.log(`- DEFAULT_DOMAIN_ID=${domainId}`);

  if (!configuredDefaultDomainId || configuredDefaultDomainId !== domainId) {
    console.log('\nAction required: update DEFAULT_DOMAIN_ID to the Resend domain id above and redeploy backend.');
  } else {
    console.log('\nDEFAULT_DOMAIN_ID already matches Resend domain id.');
  }
};

run()
  .then(() => {
    console.log('\nDefault domain bootstrap complete.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Default domain bootstrap failed:', error);
    process.exit(1);
  });

