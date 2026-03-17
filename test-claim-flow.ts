/**
 * End-to-end test: Agent registration → Ownership claim flow
 *
 * Usage: npx ts-node --transpile-only test-claim-flow.ts
 */
import { generateKeyPairSync, sign, createPrivateKey } from 'crypto';

const API = 'http://localhost:8000';
const OWNER_EMAIL = 'shanjai@commune.email';

// DER prefixes for Ed25519 key manipulation
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX_LEN = 12; // bytes to skip in SPKI DER to get raw public key

async function main() {
  console.log('=== Agent Claim Flow Test ===\n');

  // Step 1: Generate Ed25519 keypair
  console.log('1. Generating Ed25519 keypair...');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const rawPrivateKey = privateKey.slice(16);
  const rawPublicKey = publicKey.slice(SPKI_PREFIX_LEN);
  const publicKeyBase64 = rawPublicKey.toString('base64');
  console.log(`   Public key: ${publicKeyBase64}\n`);

  // Step 2: Register agent
  const slug = `test-claim-${Date.now()}`;
  console.log(`2. Registering agent with slug: ${slug}...`);
  const regRes = await fetch(`${API}/v1/auth/agent-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentName: 'Claim Test Agent',
      agentPurpose: 'I handle customer support tickets by classifying and routing them to the right team members efficiently.',
      orgName: 'Test Org',
      orgSlug: slug,
      publicKey: publicKeyBase64,
    }),
  });
  const regData = await regRes.json();
  if (!regRes.ok) {
    console.error('   Registration failed:', regData);
    process.exit(1);
  }
  console.log(`   Token: ${regData.agentSignupToken.slice(0, 20)}...`);
  console.log(`   Challenge received.\n`);

  // Step 3: Solve challenge
  console.log('3. Solving challenge...');
  const purpose = 'I handle customer support tickets by classifying and routing them to the right team members efficiently.';
  // Count 5+ char words
  const longWords = purpose.trim().split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 5);
  console.log(`   5+ char words: ${longWords.join(', ')} (count: ${longWords.length})`);

  // Extract epoch marker from challenge text
  const challengeText = regData.challenge.text;
  const epochMatch = challengeText.match(/Include this exact string: ([a-f0-9]{16})/);
  if (!epochMatch) {
    console.error('   Could not find epoch marker in challenge');
    process.exit(1);
  }
  const epochMarker = epochMatch[1];
  const challengeResponse = `handle:${longWords.length}:${epochMarker}`;
  console.log(`   Response: ${challengeResponse}`);

  // Sign the challenge response
  const privKeyObj = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, rawPrivateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = sign(null, Buffer.from(challengeResponse), privKeyObj).toString('base64');
  console.log(`   Signature: ${sig.slice(0, 30)}...\n`);

  // Step 4: Verify
  console.log('4. Verifying challenge...');
  const verifyRes = await fetch(`${API}/v1/auth/agent-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentSignupToken: regData.agentSignupToken,
      challengeResponse,
      signature: sig,
    }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) {
    console.error('   Verification failed:', verifyData);
    process.exit(1);
  }
  console.log(`   Agent ID: ${verifyData.agentId}`);
  console.log(`   Inbox: ${verifyData.inboxEmail}`);
  console.log(`   Ownership: ${verifyData.ownershipStatus}`);
  console.log(`   Next step: ${verifyData.nextStep?.action}`);
  console.log();

  // Step 5: Try to send email (should be blocked)
  console.log('5. Trying to send email (should fail with ownership_required)...');
  const ts1 = String(Date.now());
  const msg1 = Buffer.from(`${verifyData.agentId}:${ts1}`);
  const sig1 = sign(null, msg1, privKeyObj).toString('base64');
  const sendRes = await fetch(`${API}/v1/messages/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Agent ${verifyData.agentId}:${sig1}`,
      'X-Commune-Timestamp': ts1,
    },
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Test',
      text: 'This should be blocked',
    }),
  });
  const sendData = await sendRes.json();
  console.log(`   Status: ${sendRes.status}`);
  console.log(`   Error: ${sendData.error}`);
  console.log(`   Message: ${sendData.message}`);
  console.log();

  // Step 6: Claim ownership
  console.log(`6. Claiming ownership (sending to ${OWNER_EMAIL})...`);
  const ts2 = String(Date.now());
  const msg2 = Buffer.from(`${verifyData.agentId}:${ts2}`);
  const sig2 = sign(null, msg2, privKeyObj).toString('base64');
  const claimRes = await fetch(`${API}/v1/agent/claim-ownership`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Agent ${verifyData.agentId}:${sig2}`,
      'X-Commune-Timestamp': ts2,
    },
    body: JSON.stringify({ ownerEmail: OWNER_EMAIL }),
  });
  const claimData = await claimRes.json();
  console.log(`   Status: ${claimRes.status}`);
  console.log(`   Response:`, JSON.stringify(claimData, null, 2));
  console.log();

  if (claimRes.ok) {
    console.log(`✓ Claim email sent to ${OWNER_EMAIL}!`);
    console.log(`  Check inbox for the claim link.`);
    console.log(`  Click it to complete the flow.`);
  } else {
    console.log(`✗ Claim failed:`, claimData);
  }

  console.log('\n=== Test complete ===');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
