/**
 * E2E test for the agent claim flow.
 * Registers a new agent, verifies it, tries to send (blocked),
 * calls claim-ownership, and checks the result.
 */
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

const API = 'https://web-production-3f46f.up.railway.app';
const OWNER_EMAIL = 'shanjairajdev@gmail.com';

async function run() {
  console.log('=== Agent Claim Flow Test ===\n');

  // 1. Generate Ed25519 keypair
  const kp = nacl.sign.keyPair();
  const pubB64 = Buffer.from(kp.publicKey).toString('base64');
  console.log('1. Generated Ed25519 keypair');
  console.log(`   Public key: ${pubB64}\n`);

  // 2. Register
  const slug = `test-claim-${Date.now()}`;
  const regRes = await fetch(`${API}/v1/auth/agent-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentName: 'E2E Claim Test Agent',
      agentPurpose: 'I handle customer support tickets by classifying and routing them to the right team members efficiently.',
      orgName: 'E2E Test Org',
      orgSlug: slug,
      publicKey: pubB64,
    }),
  });
  const reg = await regRes.json();
  const signupToken = reg.signupToken || reg.agentSignupToken;
  if (!signupToken) { console.error('Registration failed:', reg); return; }
  console.log(`2. Registered agent with slug: ${slug}`);
  console.log(`   Token: ${signupToken.slice(0, 20)}...`);
  console.log('   Challenge received.\n');

  // 3. Solve challenge
  // Extract the purpose text from the challenge
  const purposeMatch = reg.challenge.text.match(/Your stated purpose:\n"([^"]+)"/);
  const purposeText = purposeMatch ? purposeMatch[1] : 'I handle customer support tickets by classifying and routing them to the right team members efficiently.';
  // Count words with 5+ alphabetical chars (strip punctuation first)
  const purposeWords = purposeText.split(/\s+/).filter((w: string) => w.replace(/[^a-zA-Z]/g, '').length >= 5);
  // Extract epoch marker
  const epochMatch = reg.challenge.text.match(/Include this exact string: ([a-f0-9]+)/);
  const epochMarker = epochMatch ? epochMatch[1] : '';
  // Primary verb
  const verb = 'handle';
  const answer = `${verb}:${purposeWords.length}:${epochMarker}`;
  console.log(`3. Solving challenge...`);
  console.log(`   Purpose words (5+ chars): ${purposeWords.join(', ')} (count: ${purposeWords.length})`);
  console.log(`   Epoch marker: ${epochMarker}`);
  const msgBytes = new TextEncoder().encode(answer);
  const sig = nacl.sign.detached(msgBytes, kp.secretKey);
  const sigB64 = Buffer.from(sig).toString('base64');
  console.log(`   Response: ${answer}`);
  console.log(`   Signature: ${sigB64.slice(0, 40)}...\n`);

  // 4. Verify challenge
  const verRes = await fetch(`${API}/v1/auth/agent-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentSignupToken: signupToken,
      challengeResponse: answer,
      signature: sigB64,
    }),
  });
  const ver = await verRes.json();
  if (!ver.agentId) { console.error('Verification failed:', ver); return; }
  console.log('4. Verified agent');
  console.log(`   Agent ID: ${ver.agentId}`);
  console.log(`   Inbox: ${ver.inboxEmail}`);
  console.log(`   Ownership: ${ver.ownershipStatus}`);
  console.log(`   Next step: ${ver.nextStep?.action}\n`);

  // Helper: sign a request (format: Agent {agentId}:{sig}, timestamp in X-Commune-Timestamp)
  const signReq = (agentId: string) => {
    const ts = Date.now();
    const message = `${agentId}:${ts}`;
    const msgBuf = new TextEncoder().encode(message);
    const s = nacl.sign.detached(msgBuf, kp.secretKey);
    return {
      'Authorization': `Agent ${agentId}:${Buffer.from(s).toString('base64')}`,
      'X-Commune-Timestamp': String(ts),
      'Content-Type': 'application/json',
    };
  };

  // 5. Try to send email (should fail with ownership_required)
  const sendRes = await fetch(`${API}/v1/messages/send`, {
    method: 'POST',
    headers: signReq(ver.agentId),
    body: JSON.stringify({
      channel: 'email',
      to: 'test@example.com',
      subject: 'Test',
      text: 'Hello',
    }),
  });
  const sendData = await sendRes.json();
  console.log(`5. Trying to send email (should fail with ownership_required)...`);
  console.log(`   Status: ${sendRes.status}`);
  console.log(`   Error: ${sendData.error}`);
  console.log(`   Message: ${sendData.message}\n`);

  // 6. Claim ownership
  console.log(`6. Claiming ownership (sending to ${OWNER_EMAIL})...`);
  const claimRes = await fetch(`${API}/v1/agent/claim-ownership`, {
    method: 'POST',
    headers: signReq(ver.agentId),
    body: JSON.stringify({ ownerEmail: OWNER_EMAIL }),
  });
  const claimData = await claimRes.json();
  console.log(`   Status: ${claimRes.status}`);
  console.log(`   Response: ${JSON.stringify(claimData, null, 2)}`);

  if (claimRes.status === 200) {
    console.log('\n✓ Claim email sent! Check your Gmail for the claim link.');
  } else {
    console.log(`\n✗ Claim failed: ${JSON.stringify(claimData)}`);
  }

  console.log('\n=== Test complete ===');
}

run().catch(console.error);
