/**
 * Duplicate AHL UTM Flow V2 Generator (Consultation & Payment Optimized)
 * 
 * Features & Fixes:
 * - Untouched live flow: Updates "AHL UTM Flow - V2 (Consultation & Payment Optimized)".
 * - Test Webhook URL: https://n8n.hairscalptradingco.com/webhook-test/79a84078-337b-44d7-9f98-ded629f37c86
 * - Removed Call Now option and Call Now template completely.
 * - Removed duplicate Razorpay link (single clean link in text + interactive [Confirmed Payment] button).
 * - Connected "Confirmed Payment" to:
 *     1) n8n payment confirmation webhook (records status: 'Customer Confirmed (Verification Pending)')
 *     2) Confirmation message stating team is verifying payment + requesting 1-2 scalp photos.
 * - Unified 2-minute technical video for all 4 products.
 * - Fixed ₹500 fee across all copy.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N8N_WEBHOOK_URL = 'https://n8n.hairscalptradingco.com/webhook-test/79a84078-337b-44d7-9f98-ded629f37c86';
const TECH_VIDEO_URL = 'https://youtu.be/B7kamqdiJSY?si=GzSAwvGucX1Lvues';
const RAZORPAY_PAYMENT_URL = 'https://rzp.io/rzp/ahl-consultation-wa';

// Map human-readable node names to valid UUIDs
const idMap = new Map();
function getId(name) {
  if (!idMap.has(name)) {
    idMap.set(name, crypto.randomUUID());
  }
  return idMap.get(name);
}

// Build graph nodes
const nodes = [
  // --- STEP 1: INITIAL N8N WEBHOOK & NAME REQUEST ---
  {
    id: getId('webhook_1'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 100, y: 200 }
  },
  {
    id: getId('ask_name'),
    node_type: 'ask_text',
    config: {
      text: "Hello! 👋 Welcome to American Hairline.\nWe're delighted to connect with you! To help you with the right specialist, may we know your *Name*?",
      var_name: 'name',
      remind_on_invalid: true,
      invalid_reply_message: 'Please share your name so we can assist you better 🙏'
    },
    position: { x: 350, y: 200 }
  },

  // --- STEP 2: POST-NAME N8N WEBHOOK & CITY SELECTION ---
  {
    id: getId('webhook_2'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 600, y: 200 }
  },
  {
    id: getId('ask_city'),
    node_type: 'ask_list',
    config: {
      text: 'Nice to connect with you! 😊 Which city are you currently located in? (Tap below to select):',
      var_name: 'city',
      buttons: [
        { label: 'Mumbai' },
        { label: 'Bangalore' },
        { label: 'Hyderabad' },
        { label: 'Delhi' },
        { label: 'Pune' },
        { label: 'Kolkata' },
        { label: 'Chennai' },
        { label: 'Jaipur' },
        { label: 'Lucknow' },
        { label: 'None of the above' }
      ]
    },
    position: { x: 850, y: 200 }
  },
  {
    id: getId('ask_custom_city'),
    node_type: 'ask_text',
    config: {
      text: 'No problem! Could you please type and send the city or region you are from?',
      var_name: 'city'
    },
    position: { x: 1100, y: 450 }
  },

  // --- STEP 3: POST-CITY N8N WEBHOOK & PRODUCT SELECTION ---
  {
    id: getId('webhook_3'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 1150, y: 200 }
  },
  {
    id: getId('ask_product'),
    node_type: 'ask_button',
    config: {
      text: 'To guide you to the right hair specialist, which hair solution would you like to explore today? 👇',
      var_name: 'product',
      buttons: [
        { label: 'Hair Patch' },
        { label: 'Scalp Micro Pigmentation' },
        { label: 'Hair Transplant' },
        { label: 'Front Hairline' }
      ]
    },
    position: { x: 1400, y: 200 }
  },

  // --- STEP 4: PRODUCT BRANCHING ---
  // Hair Patch Sub-options (Clip-On / Stick-On / Need Help)
  {
    id: getId('ask_hair_patch_type'),
    node_type: 'ask_button',
    config: {
      text: 'Great choice! Which type of Hair Patch system are you interested in? (Tap below):',
      var_name: 'patch_type',
      buttons: [
        { label: 'Clip-On' },
        { label: 'Stick-On' },
        { label: 'Need Help' }
      ]
    },
    position: { x: 1680, y: 80 }
  },

  // --- STEP 5: 2-MINUTE TECHNICAL EXPLAINER VIDEO ---
  {
    id: getId('send_tech_video'),
    node_type: 'message_text',
    config: {
      text: `Awesome! Before we proceed, take a quick look at this 2-minute technical video explaining how our natural hair systems work:\n\n🎬 *Watch Video:* ${TECH_VIDEO_URL}\n\n(This will give you a clear view of our seamless technique and results!)`
    },
    position: { x: 1950, y: 200 }
  },

  // --- STEP 6: URGENCY SELECTION ---
  {
    id: getId('ask_urgency'),
    node_type: 'ask_button',
    config: {
      text: 'Got it! To help us organize your consultation schedule, how soon are you looking for a solution?',
      var_name: 'urgency',
      buttons: [
        { label: 'Within 3 Days' },
        { label: 'Within a Week' },
        { label: 'Within a Month' },
        { label: 'Not Urgent' }
      ]
    },
    position: { x: 2250, y: 200 }
  },

  // --- STEP 7: PLATFORM / CONSULTATION MODE (Call Now completely removed) ---
  {
    id: getId('ask_platform'),
    node_type: 'ask_button',
    config: {
      text: 'Which consultation format would be most comfortable for you? 👇',
      var_name: 'platform',
      buttons: [
        { label: 'Book Online Consult' },
        { label: 'In-Person Consult' }
      ]
    },
    position: { x: 2550, y: 200 }
  },

  // --- STEP 8: TIME SLOT SELECTION & CONSULTATION WEBHOOK ---
  {
    id: getId('webhook_consult_init'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 2850, y: 200 }
  },
  {
    id: getId('ask_time_slot'),
    node_type: 'ask_list',
    config: {
      text: 'Perfect! Please choose your preferred consultation time slot:\n(Nominal ₹500 fee, 100% adjusted in your final service package) 🗓️',
      var_name: 'consultation_slot',
      buttons: [
        { label: 'Tomorrow - 12:00 PM' },
        { label: 'Tomorrow - 02:00 PM' },
        { label: 'Tomorrow - 04:00 PM' },
        { label: 'Tomorrow - 06:00 PM' }
      ]
    },
    position: { x: 3100, y: 200 }
  },

  // --- STEP 9: CLEAN PAYMENT PROMPT (SINGLE LINK + INTERACTIVE CONFIRMED PAYMENT BUTTON) ---
  {
    id: getId('send_payment_link'),
    node_type: 'message_buttons',
    config: {
      text: `Your consultation slot is tentatively reserved! ⏳\n\nTo lock your appointment pass, please complete the ₹500 consultation fee using the link below:\n👉 ${RAZORPAY_PAYMENT_URL}\n\n(100% adjusted against your final package. Supports GPay, PhonePe, Paytm & UPI)\n\nOnce completed, tap below:`,
      var_name: 'payment_status',
      buttons: [
        { label: 'Confirmed Payment' }
      ]
    },
    position: { x: 3400, y: 200 }
  },

  // --- STEP 10: CONFIRMED PAYMENT ACTION (WEBHOOK + VERIFICATION & PHOTO REQUEST) ---
  {
    id: getId('webhook_payment_confirmed'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 3700, y: 150 }
  },
  {
    id: getId('msg_payment_confirmed'),
    node_type: 'message_text',
    config: {
      text: 'Thank you! 🙏 We have received your appointment confirmation request. Our team will verify your payment details shortly.\n\nTo help our senior hair specialist study your hair loss pattern before your session, please share 1-2 clear photos of your scalp (top, front & crown) here. All photos remain 100% confidential. 📸'
    },
    position: { x: 3980, y: 150 }
  },

  // --- STEP 11: DROP-OFF / TIMEOUT HANDLING (IF NO PAYMENT / NO REPLY) ---
  {
    id: getId('wait_payment_reply'),
    node_type: 'wait_reply',
    config: {
      label: 'Wait for client reply / payment'
    },
    position: { x: 3700, y: 350 }
  },
  {
    id: getId('ask_resistance_followup'),
    node_type: 'ask_button',
    config: {
      text: 'Hi! We noticed your consultation slot is still pending confirmation. How can we best assist you?',
      var_name: 'resistance_choice',
      buttons: [
        { label: 'Need more details' },
        { label: 'Call me first' }
      ]
    },
    position: { x: 4000, y: 350 }
  },
  {
    id: getId('send_more_info_video'),
    node_type: 'message_text',
    config: {
      text: `Here is our detailed technical video explaining non-surgical hair replacement:\n👉 ${TECH_VIDEO_URL}\n\nWhenever you are ready, you can book your slot anytime!`
    },
    position: { x: 4300, y: 250 }
  },
  {
    id: getId('webhook_urgent_callback'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 4300, y: 450 }
  },
  {
    id: getId('msg_callback_confirmed'),
    node_type: 'message_text',
    config: {
      text: 'Understood! Our senior clinic advisor will call you shortly to assist you with all your queries.'
    },
    position: { x: 4550, y: 450 }
  }
];

// Graph Connections (Edges)
const edges = [
  // Start: Webhook 1 -> Ask Name
  { from_node_id: getId('webhook_1'), to_node_id: getId('ask_name') },

  // Ask Name -> Webhook 2 (Updates Name) -> Ask City
  { from_node_id: getId('ask_name'), to_node_id: getId('webhook_2') },
  { from_node_id: getId('webhook_2'), to_node_id: getId('ask_city') },

  // City List Options -> Webhook 3 (Updates City) -> Ask Product
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Mumbai' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Bangalore' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Hyderabad' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Delhi' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Pune' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Kolkata' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Chennai' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Jaipur' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Lucknow' },

  // "None of the above" -> Ask Custom City -> Webhook 3 -> Ask Product
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_custom_city'), branch_label: 'None of the above' },
  { from_node_id: getId('ask_custom_city'), to_node_id: getId('webhook_3') },

  // Webhook 3 -> Ask Product
  { from_node_id: getId('webhook_3'), to_node_id: getId('ask_product') },

  // --- PRODUCT SELECTION ROUTING ---
  // 1. Hair Patch -> Ask Patch Type -> Technical Video
  { from_node_id: getId('ask_product'), to_node_id: getId('ask_hair_patch_type'), branch_label: 'Hair Patch' },
  { from_node_id: getId('ask_hair_patch_type'), to_node_id: getId('send_tech_video'), branch_label: 'Clip-On' },
  { from_node_id: getId('ask_hair_patch_type'), to_node_id: getId('send_tech_video'), branch_label: 'Stick-On' },
  { from_node_id: getId('ask_hair_patch_type'), to_node_id: getId('send_tech_video'), branch_label: 'Need Help' },

  // 2. Scalp Micro Pigmentation -> Directly to Technical Video
  { from_node_id: getId('ask_product'), to_node_id: getId('send_tech_video'), branch_label: 'Scalp Micro Pigmentation' },

  // 3. Hair Transplant -> Directly to Technical Video
  { from_node_id: getId('ask_product'), to_node_id: getId('send_tech_video'), branch_label: 'Hair Transplant' },

  // 4. Front Hairline -> Directly to Technical Video
  { from_node_id: getId('ask_product'), to_node_id: getId('send_tech_video'), branch_label: 'Front Hairline' },

  // Technical Video -> Ask Urgency
  { from_node_id: getId('send_tech_video'), to_node_id: getId('ask_urgency') },

  // Urgency Options -> Ask Platform
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Within 3 Days' },
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Within a Week' },
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Within a Month' },
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Not Urgent' },

  // Platform Options (Only Online & In-Person, Call Now removed):
  { from_node_id: getId('ask_platform'), to_node_id: getId('webhook_consult_init'), branch_label: 'Book Online Consult' },
  { from_node_id: getId('ask_platform'), to_node_id: getId('webhook_consult_init'), branch_label: 'In-Person Consult' },
  { from_node_id: getId('webhook_consult_init'), to_node_id: getId('ask_time_slot') },

  // Time Slots -> Send Payment Link
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 12:00 PM' },
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 02:00 PM' },
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 04:00 PM' },
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 06:00 PM' },

  // Payment Link -> Confirmed Payment Button -> Webhook (n8n test) -> Confirmation Message & Photo Request
  { from_node_id: getId('send_payment_link'), to_node_id: getId('webhook_payment_confirmed'), branch_label: 'Confirmed Payment' },
  { from_node_id: getId('webhook_payment_confirmed'), to_node_id: getId('msg_payment_confirmed') },

  // Payment Link -> Wait for Reply / Timeout -> Resistance Followup
  { from_node_id: getId('send_payment_link'), to_node_id: getId('wait_payment_reply') },
  { from_node_id: getId('wait_payment_reply'), to_node_id: getId('ask_resistance_followup') },

  // Resistance Options:
  // 1) Need more details -> Send technical video
  { from_node_id: getId('ask_resistance_followup'), to_node_id: getId('send_more_info_video'), branch_label: 'Need more details' },

  // 2) Call me first -> Urgent Callback Webhook -> Confirmation Message
  { from_node_id: getId('ask_resistance_followup'), to_node_id: getId('webhook_urgent_callback'), branch_label: 'Call me first' },
  { from_node_id: getId('webhook_urgent_callback'), to_node_id: getId('msg_callback_confirmed') }
];

const completeFlowV2 = {
  name: 'AHL UTM Flow - V2 (Consultation & Payment Optimized)',
  enabled: false, // SAFE: Created as disabled/draft so live flow is 100% untouched
  trigger_type: 'keyword',
  trigger_config: {
    phrases: ['mai set bani', 'Hi! Tell me more', 'Tell me more'],
    match: 'contains'
  },
  priority: 200,
  graph: {
    start_node_id: getId('webhook_1'),
    nodes,
    edges
  }
};

const outputPath = path.join(__dirname, 'ahl_utm_flow_v2.json');
fs.writeFileSync(outputPath, JSON.stringify(completeFlowV2, null, 2));

console.log(`Successfully generated AHL UTM Flow V2!`);
console.log(`Total Nodes: ${nodes.length}`);
console.log(`Total Edges: ${edges.length}`);
console.log(`- Start Node: Webhook 1 (${getId('webhook_1')}) -> Ask Name`);
console.log(`- Test n8n Webhook: ${N8N_WEBHOOK_URL}`);
console.log(`- Removed "Call Now" option and template.`);
console.log(`- Removed duplicate link (link printed once + [Confirmed Payment] button).`);
console.log(`- Connected "Confirmed Payment" -> Webhook -> Confirmation message & photo request.`);
console.log(`- JSON written to: ${outputPath}`);
