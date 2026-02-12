import { connect, setupCollections } from '../db';
import { OrganizationService } from '../services/organizationService';
import { randomBytes } from 'crypto';

export const migrateToAuth = async () => {
  const db = await connect();
  if (!db) {
    throw new Error('Failed to connect to database');
  }

  console.log('Setting up new collections and indexes...');
  await setupCollections(db);

  console.log('Creating default organization for existing data...');
  const defaultOrg = await OrganizationService.createOrganization({
    name: 'Default Organization',
    slug: 'default',
    settings: {
      emailVerificationRequired: false,
      maxApiKeys: 100,
      maxUsers: 50
    }
  });

  console.log('Migrating existing domains to default organization...');
  const domainsCollection = db.collection('domains');
  const result = await domainsCollection.updateMany(
    { orgId: { $exists: false } },
    { $set: { orgId: defaultOrg.id } }
  );

  console.log('Migration complete!');
  console.log(`Default organization ID: ${defaultOrg.id}`);
  console.log(`Domains migrated: ${result.modifiedCount}`);
  console.log('');
  console.log('IMPORTANT: Please create admin users manually through the API:');
  console.log('POST /api/auth/register with orgName, orgSlug, email, name, password');
  console.log('');
  console.log('Then verify the email and login to access the dashboard.');
};

if (require.main === module) {
  migrateToAuth()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
