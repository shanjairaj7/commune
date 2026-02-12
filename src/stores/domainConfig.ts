import fs from 'fs';
import path from 'path';

const configPath = path.join(__dirname, '..', '..', 'config', 'domains.json');

type DomainConfig = {
  domains: Record<string, unknown>[];
};

const loadConfig = (): DomainConfig => {
  if (!fs.existsSync(configPath)) {
    return { domains: [] };
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  if (!raw.trim()) {
    return { domains: [] };
  }

  return JSON.parse(raw) as DomainConfig;
};

const saveConfig = (config: DomainConfig): void => {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
};

const upsertDomain = (entry: Record<string, unknown>) => {
  const config = loadConfig();
  const index = config.domains.findIndex(
    (domain) => domain.id === entry.id || domain.name === entry.name
  );

  if (index === -1) {
    config.domains.push(entry);
  } else {
    config.domains[index] = {
      ...config.domains[index],
      ...entry,
    };
  }

  saveConfig(config);
  return entry;
};

const getDomainById = (id: string) => {
  const config = loadConfig();
  return config.domains.find((domain) => domain.id === id) || null;
};

const getDomainByName = (name: string) => {
  const config = loadConfig();
  return config.domains.find((domain) => domain.name === name) || null;
};

const setDomainWebhook = (id: string, webhook: Record<string, unknown>) => {
  const existing = getDomainById(id);
  if (!existing) {
    return null;
  }

  return upsertDomain({
    ...existing,
    webhook,
  });
};

const setDomainRecords = (id: string, records: unknown[]) => {
  const existing = getDomainById(id);
  if (!existing) {
    return null;
  }

  return upsertDomain({
    ...existing,
    records,
  });
};

export {
  loadConfig,
  saveConfig,
  upsertDomain,
  getDomainById,
  getDomainByName,
  setDomainWebhook,
  setDomainRecords,
};
