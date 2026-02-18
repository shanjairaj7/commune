/**
 * Investigate Delayed Webhook Events
 *
 * This script connects to the MongoDB database and analyzes:
 * 1. Recent delivery_delayed events
 * 2. The messages associated with them
 * 3. Patterns in delayed deliveries
 * 4. Root causes
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://postking07_db_user:oIB00tCCnyDVw7a3@commune-db.drrxp0j.mongodb.net/?appName=commune-db';
const DB_NAME = 'commune';

async function investigateDelayedEvents() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db(DB_NAME);

    // 1. Get recent delivery_delayed events
    console.log('━━━ RECENT DELIVERY_DELAYED EVENTS ━━━\n');
    const delayedEvents = await db.collection('delivery_events')
      .find({ event_type: 'delivery_delayed' })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();

    console.log(`Found ${delayedEvents.length} recent delayed events\n`);

    if (delayedEvents.length === 0) {
      console.log('No delayed events found. This might mean:');
      console.log('  1. Your emails are delivering successfully');
      console.log('  2. The events you saw are from a different environment');
      console.log('  3. The webhook events haven\'t been processed yet\n');

      // Check all events
      const allEvents = await db.collection('delivery_events')
        .find({})
        .sort({ created_at: -1 })
        .limit(50)
        .toArray();

      console.log(`\nFound ${allEvents.length} total delivery events (all types)\n`);

      if (allEvents.length === 0) {
        console.log('⚠️  No delivery events found at all.');
        console.log('This suggests webhooks may not be configured or events are not being stored.\n');
        return;
      }
    }

    // 2. Analyze each delayed event
    const messageIds = [...new Set(delayedEvents.map(e => e.message_id))];
    console.log(`━━━ ANALYZING ${messageIds.length} UNIQUE MESSAGES ━━━\n`);

    for (const messageId of messageIds.slice(0, 10)) {
      const message = await db.collection('messages').findOne({ message_id: messageId });

      if (!message) {
        console.log(`\n📧 Message: ${messageId}`);
        console.log('   ⚠️  Message not found in database (orphan event)');

        // Get all events for this message
        const events = await db.collection('delivery_events')
          .find({ message_id: messageId })
          .sort({ created_at: 1 })
          .toArray();

        console.log(`   Events (${events.length}):`);
        events.forEach((e: any) => {
          const recipient = e.event_data?.data?.to?.[0] || e.event_data?.to?.[0] || 'unknown';
          console.log(`     - ${e.event_type} at ${new Date(e.created_at).toLocaleString()} (to: ${recipient})`);
        });
        continue;
      }

      // Get recipient
      const toParticipant = (message as any).participants?.find((p: any) => p.role === 'to');
      const recipient = toParticipant?.identity || 'unknown';

      // Get all delivery events for this message
      const events = await db.collection('delivery_events')
        .find({ message_id: messageId })
        .sort({ created_at: 1 })
        .toArray();

      const delayCount = events.filter((e: any) => e.event_type === 'delivery_delayed').length;

      console.log(`\n📧 Message: ${messageId}`);
      console.log(`   To: ${recipient}`);
      console.log(`   Subject: ${(message as any).metadata?.subject || 'N/A'}`);
      console.log(`   Status: ${(message as any).delivery_status}`);
      console.log(`   Sent at: ${(message as any).sent_at ? new Date((message as any).sent_at).toLocaleString() : 'N/A'}`);

      if ((message as any).delivery_status === 'delivered') {
        console.log(`   ✅ Delivered at: ${new Date((message as any).delivered_at).toLocaleString()}`);
        const deliveryTime = new Date((message as any).delivered_at).getTime() - new Date((message as any).sent_at).getTime();
        console.log(`   ⏱️  Total delivery time: ${Math.round(deliveryTime / 1000 / 60)} minutes`);
      } else if ((message as any).delivery_status === 'bounced') {
        console.log(`   ❌ Bounced: ${(message as any).bounce_reason}`);
        console.log(`   Bounce type: ${(message as any).bounce_type}`);
      } else {
        // Still pending
        const timeSinceSent = Date.now() - new Date((message as any).sent_at).getTime();
        console.log(`   ⏳ Still pending (${Math.round(timeSinceSent / 1000 / 60)} minutes since sent)`);
      }

      console.log(`   Delay count: ${delayCount}`);
      console.log(`   Event timeline (${events.length} events):`);
      events.forEach((e: any) => {
        const icon = e.event_type === 'sent' ? '→' :
                     e.event_type === 'delivered' ? '✓' :
                     e.event_type === 'bounced' ? '✗' :
                     e.event_type === 'delivery_delayed' ? '~' : '•';
        console.log(`     ${icon} ${e.event_type} at ${new Date(e.created_at).toLocaleString()}`);

        // Show delay reason if available
        if (e.event_type === 'delivery_delayed' && e.event_data?.data?.delayed) {
          console.log(`       Reason: ${e.event_data.data.delayed.reason || 'Unknown'}`);
          console.log(`       SMTP: ${e.event_data.data.delayed.smtp_code || 'N/A'}`);
        }
      });
    }

    // 3. Summary statistics
    console.log('\n━━━ SUMMARY STATISTICS ━━━\n');

    const totalMessages = await db.collection('messages').countDocuments();
    const sentMessages = await db.collection('messages').countDocuments({ delivery_status: 'sent' });
    const deliveredMessages = await db.collection('messages').countDocuments({ delivery_status: 'delivered' });
    const bouncedMessages = await db.collection('messages').countDocuments({ delivery_status: 'bounced' });
    const delayedMessages = messageIds.length;

    console.log(`Total messages: ${totalMessages}`);
    console.log(`Sent: ${sentMessages} (${totalMessages > 0 ? ((sentMessages / totalMessages) * 100).toFixed(1) : 0}%)`);
    console.log(`Delivered: ${deliveredMessages} (${totalMessages > 0 ? ((deliveredMessages / totalMessages) * 100).toFixed(1) : 0}%)`);
    console.log(`Bounced: ${bouncedMessages} (${totalMessages > 0 ? ((bouncedMessages / totalMessages) * 100).toFixed(1) : 0}%)`);
    console.log(`Experienced delays: ${delayedMessages} (${totalMessages > 0 ? ((delayedMessages / totalMessages) * 100).toFixed(1) : 0}%)`);

    // 4. Find common patterns
    console.log('\n━━━ DELAY PATTERNS ━━━\n');

    // Group by recipient domain
    const recipientDomains: Record<string, number> = {};
    for (const event of delayedEvents) {
      const recipient = (event as any).event_data?.data?.to?.[0] || (event as any).event_data?.to?.[0];
      if (recipient && recipient.includes('@')) {
        const domain = recipient.split('@')[1];
        recipientDomains[domain] = (recipientDomains[domain] || 0) + 1;
      }
    }

    console.log('Delayed events by recipient domain:');
    Object.entries(recipientDomains)
      .sort((a, b) => b[1] - a[1])
      .forEach(([domain, count]) => {
        console.log(`  ${domain}: ${count} delays`);
      });

    // 5. Recent activity
    console.log('\n━━━ RECENT WEBHOOK ACTIVITY (All Types) ━━━\n');
    const recentEvents = await db.collection('delivery_events')
      .find({})
      .sort({ created_at: -1 })
      .limit(30)
      .toArray();

    recentEvents.forEach((e: any) => {
      const icon = e.event_type === 'sent' ? '→' :
                   e.event_type === 'delivered' ? '✓' :
                   e.event_type === 'bounced' ? '✗' :
                   e.event_type === 'delivery_delayed' ? '~' : '•';
      const time = new Date(e.created_at).toLocaleTimeString();
      const recipient = e.event_data?.data?.to?.[0] || e.event_data?.to?.[0] || 'unknown';
      const msgId = e.message_id?.slice(0, 13) || 'unknown';
      console.log(`${icon} ${time} - ${e.event_type.padEnd(18)} - ${msgId} - ${recipient}`);
    });

    // 6. Resend Email IDs (if present in your events)
    console.log('\n━━━ RESEND EMAIL IDS IN RECENT EVENTS ━━━\n');
    const eventsWithResendIds = recentEvents
      .map((e: any) => ({
        eventType: e.event_type,
        resendId: e.event_data?.data?.email_id || e.event_data?.email_id,
        created: e.created_at,
      }))
      .filter(e => e.resendId)
      .slice(0, 15);

    if (eventsWithResendIds.length > 0) {
      eventsWithResendIds.forEach(e => {
        const icon = e.eventType === 'sent' ? '→' :
                     e.eventType === 'delivered' ? '✓' :
                     e.eventType === 'bounced' ? '✗' :
                     e.eventType === 'delivery_delayed' ? '~' : '•';
        console.log(`${icon} ${e.resendId} - ${e.eventType} - ${new Date(e.created).toLocaleTimeString()}`);
      });
    } else {
      console.log('No Resend email IDs found in recent events.');
    }

    // 7. Check for the specific IDs from user's output
    console.log('\n━━━ CHECKING SPECIFIC EMAIL IDS FROM YOUR OUTPUT ━━━\n');
    const userEmailIds = ['e8caf715-817', '6f07babb-277', '291f3271-ad5'];

    for (const emailId of userEmailIds) {
      // Try to find events with this resend_id pattern
      const events = await db.collection('delivery_events')
        .find({
          $or: [
            { 'event_data.data.email_id': { $regex: emailId, $options: 'i' } },
            { 'event_data.email_id': { $regex: emailId, $options: 'i' } },
          ]
        })
        .sort({ created_at: 1 })
        .toArray();

      if (events.length > 0) {
        console.log(`\nFound events for ${emailId}:`);
        events.forEach((e: any) => {
          const icon = e.event_type === 'sent' ? '→' :
                       e.event_type === 'delivered' ? '✓' :
                       e.event_type === 'bounced' ? '✗' :
                       e.event_type === 'delivery_delayed' ? '~' : '•';
          console.log(`  ${icon} ${e.event_type} at ${new Date(e.created_at).toLocaleString()}`);
        });
      } else {
        console.log(`\nNo events found for ${emailId} (may not be stored yet or different format)`);
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
    console.log('\n✅ Connection closed');
  }
}

investigateDelayedEvents().catch(console.error);
