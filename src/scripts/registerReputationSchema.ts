/**
 * One-time script: register the Commune agent reputation schema on EAS (Base).
 *
 * Run once:
 *   COMMUNE_ATTESTATION_KEY=0x... npx ts-node src/scripts/registerReputationSchema.ts
 *
 * Save the returned schema UID as COMMUNE_REPUTATION_SCHEMA_UID in Railway env.
 */

import { REPUTATION_SCHEMA } from '../services/reputationService';

const SCHEMA_REGISTRY = '0x4200000000000000000000000000000000000020';

async function main() {
  const key = process.env.COMMUNE_ATTESTATION_KEY;
  if (!key) {
    console.error('Set COMMUNE_ATTESTATION_KEY (private key for signing attestations)');
    process.exit(1);
  }

  const { SchemaRegistry } = await import('@ethereum-attestation-service/eas-sdk');
  const { createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { base } = await import('viem/chains');

  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain: base, transport: http() });

  console.log('Registering schema on Base...');
  console.log('Schema:', REPUTATION_SCHEMA);
  console.log('Attester:', account.address);

  const registry = new SchemaRegistry(SCHEMA_REGISTRY);
  registry.connect(wallet as any);

  const tx = await registry.register({
    schema: REPUTATION_SCHEMA,
    resolverAddress: '0x0000000000000000000000000000000000000000', // no resolver
    revocable: true,
  });

  const schemaUID = await tx.wait();
  console.log('\nSchema registered successfully!');
  console.log('Schema UID:', schemaUID);
  console.log('\nAdd to Railway env:');
  console.log(`  COMMUNE_REPUTATION_SCHEMA_UID=${schemaUID}`);
}

main().catch((err) => {
  console.error('Failed to register schema:', err);
  process.exit(1);
});
