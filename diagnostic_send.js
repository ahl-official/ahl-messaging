
async function test() {
    const token = process.env.PORTFOLIO_AHL_WA_ACCESS_TOKEN;
    const phoneNumberId = "1198859879988526"; // AHL_WA
    const waId = "919167868154"; // tester

    const body1 = {
        messaging_product: "whatsapp",
        to: waId,
        type: "template",
        template: {
            name: "smp_price",
            language: { code: "en_US" }
        }
    };

    const res1 = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body1)
    });
    console.log("No components:", await res1.text());
}
test();
