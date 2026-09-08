import type { Env } from "./types";

export async function sendMagicLink(
  env: Env,
  to: string,
  link: string,
): Promise<{ emailed: boolean }> {
  if (!env.RESEND_API_KEY) return { emailed: false };
  const from = env.FROM_EMAIL || "Partyline <noreply@bonjia.tech>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your Partyline sign-in link",
      text: `Sign in to Partyline:\n\n${link}\n\nThis link expires in 30 minutes.`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return { emailed: true };
}
