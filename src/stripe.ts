import Stripe from "stripe";
import { config } from "./config.js";
import {
  createPayment,
  getSettings,
  listPayments,
  normalizeMac,
  sanitizePlayaName,
  sessionExpiryMs,
  updatePayment,
  upsertDevice,
} from "./db.js";
import { grantAccess } from "./firewall.js";

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!stripe) {
    stripe = new Stripe(config.stripeSecretKey);
  }
  return stripe;
}

export function stripeConfigured(): boolean {
  return Boolean(config.stripeSecretKey && config.stripePublishableKey);
}

export async function createCheckoutSession(
  mac: string,
  playaName: string,
): Promise<{ url: string; sessionId: string }> {
  const settings = getSettings();
  const client = getStripe();
  const normalized = normalizeMac(mac);
  const playa = sanitizePlayaName(playaName);
  if (!playa) throw new Error("Playa name is required");

  const session = await client.checkout.sessions.create({
    mode: "payment",
    success_url: `${config.publicUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.publicUrl}/?canceled=1`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: settings.currency,
          unit_amount: settings.price_cents,
          product_data: {
            name: `${settings.camp_name} Wi‑Fi`,
            description: `${settings.session_hours}h access for ${playa} · this device only`,
          },
        },
      },
    ],
    metadata: {
      mac: normalized,
      playa_name: playa,
      session_hours: String(settings.session_hours),
    },
    client_reference_id: normalized,
  });

  createPayment({
    mac: normalized,
    method: "stripe",
    amount_cents: settings.price_cents,
    status: "pending",
    external_id: session.id,
    playa_name: playa,
  });

  upsertDevice(normalized, {
    status: "blocked",
    stripe_session_id: session.id,
    payment_method: "stripe",
    playa_name: playa,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return { url: session.url, sessionId: session.id };
}

export async function confirmCheckoutSession(sessionId: string): Promise<{
  ok: boolean;
  mac?: string;
  message: string;
}> {
  const client = getStripe();
  const session = await client.checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== "paid" && session.status !== "complete") {
    return { ok: false, message: "Payment not completed yet." };
  }

  const mac = session.metadata?.mac || session.client_reference_id;
  if (!mac) {
    return { ok: false, message: "Missing device binding on payment." };
  }

  const playa = sanitizePlayaName(session.metadata?.playa_name || "") || null;
  const settings = getSettings();
  const paidUntil = sessionExpiryMs(settings.session_hours);
  const device = upsertDevice(mac, {
    status: "allowed",
    paid_until: paidUntil,
    stripe_session_id: sessionId,
    payment_method: "stripe",
    playa_name: playa ?? undefined,
  });

  let matched = false;
  for (const p of listPayments()) {
    if (p.external_id === sessionId) {
      updatePayment(p.id, { status: "paid", playa_name: playa });
      matched = true;
    }
  }
  if (!matched) {
    createPayment({
      mac,
      method: "stripe",
      amount_cents: session.amount_total ?? settings.price_cents,
      status: "paid",
      external_id: sessionId,
      playa_name: playa,
    });
  }

  await grantAccess(device);
  return {
    ok: true,
    mac: device.mac,
    message: `Device unlocked until ${new Date(paidUntil).toLocaleString()}.`,
  };
}
