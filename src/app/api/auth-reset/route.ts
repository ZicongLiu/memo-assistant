import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

// In-memory OTP store: projectId → { otp, expiresAt, email }
// For a single-server deployment this is fine. Restarts clear all pending OTPs.
const otpStore = new Map<string, { otp: string; expiresAt: number; email: string }>();

function makeOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getTransporter() {
  // Configure via environment variables:
  //   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
  // Falls back to Ethereal (test) transport when vars are missing.
  const host = process.env.SMTP_HOST;
  if (!host) {
    // Nodemailer Ethereal test account — useful for dev; won't actually deliver.
    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      auth: { user: "ethereal@example.com", pass: "ethereal" },
    });
  }
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { action: "send" | "verify"; projectId: string; email?: string; otp?: string };
    const { action, projectId } = body;

    if (action === "send") {
      const email = body.email;
      if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

      const otp = makeOtp();
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
      otpStore.set(projectId, { otp, expiresAt, email });

      const transporter = getTransporter();
      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? "FlowDesk <noreply@flowdesk.local>",
        to: email,
        subject: "FlowDesk — Password Reset Code",
        text: `Your verification code is: ${otp}\n\nIt expires in 15 minutes.`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px">
            <h2 style="margin:0 0 12px;color:#1e1b4b">FlowDesk Password Reset</h2>
            <p style="color:#4c4888;margin:0 0 20px">Use this code to reset your project password:</p>
            <div style="background:#f5f3ff;border-radius:12px;padding:20px;text-align:center;font-size:2rem;font-weight:700;letter-spacing:0.2em;color:#5b21b6">
              ${otp}
            </div>
            <p style="color:#9d9bc4;font-size:0.85rem;margin:16px 0 0">This code expires in 15 minutes. If you didn't request this, you can safely ignore it.</p>
          </div>`,
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "verify") {
      const record = otpStore.get(projectId);
      if (!record) return NextResponse.json({ error: "No pending reset for this project." }, { status: 400 });
      if (Date.now() > record.expiresAt) {
        otpStore.delete(projectId);
        return NextResponse.json({ error: "Code expired. Please request a new one." }, { status: 400 });
      }
      if (body.otp !== record.otp) {
        return NextResponse.json({ error: "Invalid code." }, { status: 400 });
      }
      otpStore.delete(projectId);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[auth-reset]", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
