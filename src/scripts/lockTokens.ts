import crypto from 'crypto';
import TokenGuard from '../lib/tokenGuard';
import { connect } from '../db';
import logger from '../utils/logger';

/**
 * Script to generate and lock critical tokens
 * Run this once to set up tokens permanently
 */

async function main() {
  try {
    console.log('🔒 Locking critical tokens...');
    
    // Connect to database
    await connect();
    console.log('✅ Database connected');

    // Initialize token guard
    const tokenGuard = TokenGuard;
    await tokenGuard.ensureIndexes();
    console.log('✅ Token guard indexes created');

    // Generate secure tokens
    const threadTokenSecret = crypto.randomBytes(64).toString('hex');
    const internalWebhookToken = crypto.randomBytes(64).toString('hex');
    const unsubscribeToken = crypto.randomBytes(64).toString('hex');

    console.log('\n🔑 Generated tokens:');
    console.log('THREAD_TOKEN_SECRET=', threadTokenSecret);
    console.log('INTERNAL_WEBHOOK_TOKEN=', internalWebhookToken);
    console.log('UNSUBSCRIBE_SECRET=', unsubscribeToken);

    // Lock the tokens
    await tokenGuard.lockToken('THREAD_TOKEN_SECRET', threadTokenSecret);
    await tokenGuard.lockToken('INTERNAL_WEBHOOK_TOKEN', internalWebhookToken);
    await tokenGuard.lockToken('UNSUBSCRIBE_SECRET', unsubscribeToken);

    console.log('\n🔒 Tokens locked in database');
    console.log('\n⚠️  IMPORTANT: Add these environment variables to Railway:');
    console.log('railway variables --set THREAD_TOKEN_SECRET=' + threadTokenSecret + ' --service web');
    console.log('railway variables --set INTERNAL_WEBHOOK_TOKEN=' + internalWebhookToken + ' --service web');
    console.log('railway variables --set UNSUBSCRIBE_SECRET=' + unsubscribeToken + ' --service web');

    // Verify the locks
    console.log('\n🔍 Verifying token locks...');
    const threadValid = await tokenGuard.verifyToken('THREAD_TOKEN_SECRET', threadTokenSecret);
    const webhookValid = await tokenGuard.verifyToken('INTERNAL_WEBHOOK_TOKEN', internalWebhookToken);
    const unsubValid = await tokenGuard.verifyToken('UNSUBSCRIBE_SECRET', unsubscribeToken);

    console.log('THREAD_TOKEN_SECRET lock:', threadValid ? '✅' : '❌');
    console.log('INTERNAL_WEBHOOK_TOKEN lock:', webhookValid ? '✅' : '❌');
    console.log('UNSUBSCRIBE_SECRET lock:', unsubValid ? '✅' : '❌');

    // Show all locked tokens
    const lockedTokens = await tokenGuard.getLockedTokens();
    console.log('\n📋 All locked tokens:');
    for (const token of lockedTokens) {
      console.log(`- ${token.token_type}: ${token.token_fingerprint} (locked at ${token.locked_at})`);
    }

    console.log('\n✅ Token locking completed successfully!');
    console.log('\n🚨 CRITICAL: Save these tokens securely and never change them!');

  } catch (error) {
    console.error('❌ Error locking tokens:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export default main;
