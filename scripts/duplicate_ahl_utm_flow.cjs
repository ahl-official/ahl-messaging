/**
 * Duplicate AHL UTM Flow V2 Generator (Consultation & Payment Optimized)
 * 
 * - Leaves live "AHL UTM Flow" 100% untouched.
 * - Uses engaging, conversational, low-friction questions while preserving all original options.
 * - Saves every user selection into variables (name, city, product, patch_type, urgency, platform, consultation_slot, resistance_choice).
 * - Routes all webhooks to n8n: https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook
 * - Generates valid RFC 4122 UUIDs for all nodes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N8N_WEBHOOK_URL = 'https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook';

// Map human-readable node names to valid UUIDs
const idMap = new Map();
function getId(name) {
  if (!idMap.has(name)) {
    idMap.set(name, crypto.randomUUID());
  }
  return idMap.get(name);
}

// Build the complete graph
const nodes = [
  // --- TRIGGER ---
  {
    id: getId('trigger_entry'),
    node_type: 'keyword',
    config: {
      phrases: ['mai set bani', 'Hi! Tell me more', 'Tell me more'],
      match: 'contains',
      description: 'Opening trigger matching UTM ad traffic'
    },
    position: { x: 50, y: 250 }
  },

  // --- STEP 1: INITIAL N8N WEBHOOK & NAME REQUEST ---
  {
    id: getId('webhook_1'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 300, y: 400 }
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
    position: { x: 350, y: 150 }
  },

  // --- STEP 2: POST-NAME N8N WEBHOOK & CITY SELECTION ---
  {
    id: getId('webhook_2'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 600, y: 100 }
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
    position: { x: 750, y: 200 }
  },
  {
    id: getId('ask_custom_city'),
    node_type: 'ask_text',
    config: {
      text: 'No problem! Could you please type and send the city or region you are from?',
      var_name: 'city'
    },
    position: { x: 950, y: 550 }
  },

  // --- STEP 3: POST-CITY N8N WEBHOOK & PRODUCT SELECTION ---
  {
    id: getId('webhook_3'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 1050, y: 200 }
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
    position: { x: 1250, y: 250 }
  },

  // --- STEP 4: PRODUCT BRANCHING ---
  // A) Hair Patch Sub-options
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
    position: { x: 1550, y: 50 }
  },

  // B) SMP Template + Wait for reply
  {
    id: getId('tmpl_smp'),
    node_type: 'send_template',
    config: {
      template_name: 'smp_price_details'
    },
    position: { x: 1550, y: 200 }
  },
  {
    id: getId('wait_smp'),
    node_type: 'wait_reply',
    config: {
      label: 'Client ke reply ka intezaar'
    },
    position: { x: 1800, y: 200 }
  },

  // C) Front Hairline Template + Wait for reply
  {
    id: getId('tmpl_front_hairline'),
    node_type: 'send_template',
    config: {
      template_name: 'front_hairline_system_videos_update'
    },
    position: { x: 1550, y: 400 }
  },
  {
    id: getId('wait_fhl'),
    node_type: 'wait_reply',
    config: {
      label: 'Client ke reply ka intezaar'
    },
    position: { x: 1800, y: 400 }
  },

  // --- STEP 5: URGENCY SELECTION ---
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
    position: { x: 2050, y: 250 }
  },

  // --- STEP 6: PLATFORM / CONSULTATION MODE ---
  {
    id: getId('ask_platform'),
    node_type: 'ask_button',
    config: {
      text: 'Which consultation format would be most comfortable for you? 👇',
      var_name: 'platform',
      buttons: [
        { label: 'Book Online Consult' },
        { label: 'In-Person Consult' },
        { label: 'Call Now' }
      ]
    },
    position: { x: 2350, y: 250 }
  },
  {
    id: getId('tmpl_call_now'),
    node_type: 'send_template',
    config: {
      template_name: 'call_now_utility'
    },
    position: { x: 2650, y: 450 }
  },

  // --- STEP 7 (ENHANCED): TIME SLOT SELECTION ---
  {
    id: getId('webhook_consult_init'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 2650, y: 150 }
  },
  {
    id: getId('ask_time_slot'),
    node_type: 'ask_list',
    config: {
      text: 'Perfect! Please choose your preferred consultation time slot:\n(Nominal ₹300 fee, 100% adjusted in your final service package) 🗓️',
      var_name: 'consultation_slot',
      buttons: [
        { label: 'Tomorrow - 12:00 PM' },
        { label: 'Tomorrow - 02:00 PM' },
        { label: 'Tomorrow - 04:00 PM' },
        { label: 'Tomorrow - 06:00 PM' }
      ]
    },
    position: { x: 2900, y: 200 }
  },

  // --- STEP 8 (ENHANCED): PAYMENT CTA URL BUTTON & DIRECT LINK ---
  {
    id: getId('send_payment_link'),
    node_type: 'message_buttons',
    config: {
      text: 'Your consultation slot is tentatively reserved! ⏳\n\nTo lock your appointment pass, please complete the ₹300 consultation fee using the link below:\n👉 https://rzp.io/l/ahl-consult\n\n(Supports GPay, PhonePe, Paytm & UPI)',
      var_name: 'payment_status',
      buttons: [
        { label: 'Pay ₹300 (GPay/UPI)', url: 'https://rzp.io/l/ahl-consult' },
        { label: 'Confirmed Payment' }
      ]
    },
    position: { x: 3200, y: 200 }
  },

  // --- STEP 9: OPTIONAL SCALP PHOTO REQUEST (UNBLOCKED) ---
  {
    id: getId('send_photo_request'),
    node_type: 'message_text',
    config: {
      text: 'Optional: You may also share 1-2 photos of your scalp (top, front & back) here so our senior specialist can study your hair loss pattern before your session. All photos remain 100% confidential. 📸'
    },
    position: { x: 3500, y: 150 }
  },

  // --- STEP 10 (ENHANCED): RESISTANCE & DROP-OFF HANDLING ---
  {
    id: getId('wait_payment_reply'),
    node_type: 'wait_reply',
    config: {
      label: 'Wait for client reply / payment'
    },
    position: { x: 3500, y: 350 }
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
    position: { x: 3800, y: 350 }
  },
  {
    id: getId('send_more_info_video'),
    node_type: 'message_text',
    config: {
      text: 'Here is our detailed technical video explaining non-surgical hair replacement:\n👉 https://youtu.be/americanhairline-guide\n\nWhenever you are ready, you can book your slot anytime!'
    },
    position: { x: 4100, y: 250 }
  },
  {
    id: getId('webhook_urgent_callback'),
    node_type: 'webhook',
    config: {
      url: N8N_WEBHOOK_URL,
      method: 'POST'
    },
    position: { x: 4100, y: 450 }
  },
  {
    id: getId('msg_callback_confirmed'),
    node_type: 'message_text',
    config: {
      text: 'Understood! Our senior clinic advisor will call you shortly to assist you with all your queries.'
    },
    position: { x: 4350, y: 450 }
  }
];

// Connect all edges strictly preserving every single original link
const edges = [
  // Trigger -> Webhook 1 & Name
  { from_node_id: getId('trigger_entry'), to_node_id: getId('webhook_1') },
  { from_node_id: getId('trigger_entry'), to_node_id: getId('ask_name') },

  // Name -> Webhook 2 & City List
  { from_node_id: getId('ask_name'), to_node_id: getId('webhook_2') },
  { from_node_id: getId('ask_name'), to_node_id: getId('ask_city') },

  // City List -> Webhook 3 & Product
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Mumbai' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Mumbai' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Bangalore' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Bangalore' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Hyderabad' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Hyderabad' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Delhi' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Delhi' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Pune' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Pune' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Kolkata' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Kolkata' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Chennai' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Chennai' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Jaipur' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Jaipur' },
  { from_node_id: getId('ask_city'), to_node_id: getId('webhook_3'), branch_label: 'Lucknow' },
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_product'), branch_label: 'Lucknow' },

  // None of the above -> Custom City Text -> Webhook 3 & Product
  { from_node_id: getId('ask_city'), to_node_id: getId('ask_custom_city'), branch_label: 'None of the above' },
  { from_node_id: getId('ask_custom_city'), to_node_id: getId('webhook_3') },
  { from_node_id: getId('ask_custom_city'), to_node_id: getId('ask_product') },

  // Product Selection Branches
  { from_node_id: getId('ask_product'), to_node_id: getId('ask_hair_patch_type'), branch_label: 'Hair Patch' },
  { from_node_id: getId('ask_product'), to_node_id: getId('tmpl_smp'), branch_label: 'Scalp Micro Pigmentation' },
  { from_node_id: getId('ask_product'), to_node_id: getId('ask_urgency'), branch_label: 'Hair Transplant' },
  { from_node_id: getId('ask_product'), to_node_id: getId('tmpl_front_hairline'), branch_label: 'Front Hairline' },

  // Hair Patch Sub-branches -> Urgency
  { from_node_id: getId('ask_hair_patch_type'), to_node_id: getId('ask_urgency'), branch_label: 'Clip-On' },
  { from_node_id: getId('ask_hair_patch_type'), to_node_id: getId('ask_urgency'), branch_label: 'Stick-On' },
  { from_node_id: getId('ask_hair_patch_type'), to_node_id: getId('ask_urgency'), branch_label: 'Need Help' },

  // SMP -> Wait Reply -> Urgency
  { from_node_id: getId('tmpl_smp'), to_node_id: getId('wait_smp') },
  { from_node_id: getId('wait_smp'), to_node_id: getId('ask_urgency') },

  // Front Hairline -> Wait Reply -> Urgency
  { from_node_id: getId('tmpl_front_hairline'), to_node_id: getId('wait_fhl') },
  { from_node_id: getId('wait_fhl'), to_node_id: getId('ask_urgency') },

  // Urgency Branches -> Platform
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Within 3 Days' },
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Within a Week' },
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Within a Month' },
  { from_node_id: getId('ask_urgency'), to_node_id: getId('ask_platform'), branch_label: 'Not Urgent' },

  // Platform Branches:
  // Call Now -> Template Call Now Utility
  { from_node_id: getId('ask_platform'), to_node_id: getId('tmpl_call_now'), branch_label: 'Call Now' },

  // Book Online Consult & In-Person Consult -> Webhook & Slot Selection
  { from_node_id: getId('ask_platform'), to_node_id: getId('webhook_consult_init'), branch_label: 'Book Online Consult' },
  { from_node_id: getId('ask_platform'), to_node_id: getId('ask_time_slot'), branch_label: 'Book Online Consult' },
  { from_node_id: getId('ask_platform'), to_node_id: getId('webhook_consult_init'), branch_label: 'In-Person Consult' },
  { from_node_id: getId('ask_platform'), to_node_id: getId('ask_time_slot'), branch_label: 'In-Person Consult' },

  // Time Slots -> Payment Link
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 12:00 PM' },
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 02:00 PM' },
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 04:00 PM' },
  { from_node_id: getId('ask_time_slot'), to_node_id: getId('send_payment_link'), branch_label: 'Tomorrow - 06:00 PM' },

  // Payment Link -> Photo Request (Unblocked) & Wait for Payment/Reply
  { from_node_id: getId('send_payment_link'), to_node_id: getId('send_photo_request') },
  { from_node_id: getId('send_payment_link'), to_node_id: getId('wait_payment_reply') },

  // Wait for Payment/Reply -> Resistance Followup
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
    start_node_id: getId('trigger_entry'),
    nodes,
    edges
  }
};

const outputPath = path.join(__dirname, 'ahl_utm_flow_v2.json');
fs.writeFileSync(outputPath, JSON.stringify(completeFlowV2, null, 2));
console.log(`Successfully generated AHL UTM Flow V2 with ${nodes.length} nodes and ${edges.length} edges!`);
console.log(`All webhooks set to: ${N8N_WEBHOOK_URL}`);
console.log(`All variables configured: name, city, product, patch_type, urgency, platform, consultation_slot, resistance_choice.`);
console.log(`Saved graph file to: ${outputPath}`);
