import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";

async function classifyLead(
  topic: string,
  message: string
): Promise<"hot" | "warm" | "cold"> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a lead scoring assistant for a consulting company. Classify the lead priority based on urgency, budget signals, and readiness to buy. Respond with exactly one word: hot, warm, or cold.",
          },
          {
            role: "user",
            content: `Topic: ${topic}\nMessage: ${message}`,
          },
        ],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    if (!res.ok) return "warm";

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toLowerCase();

    if (answer === "hot" || answer === "warm" || answer === "cold") {
      return answer;
    }
    return "warm";
  } catch {
    return "warm";
  }
}

async function sendTelegramNotification(lead: {
  name: string;
  email: string;
  topic: string;
  priority: string;
  message: string;
}) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.error("Telegram env vars missing:", { token: !!token, chatId: !!chatId });
      return;
    }

    const priorityEmoji =
      lead.priority === "hot"
        ? "🔥"
        : lead.priority === "warm"
          ? "🟡"
          : "🔵";

    const text = [
      `${priorityEmoji} <b>New Lead (${lead.priority.toUpperCase()})</b>`,
      ``,
      `<b>Name:</b> ${lead.name}`,
      `<b>Email:</b> ${lead.email}`,
      `<b>Topic:</b> ${lead.topic}`,
      `<b>Message:</b> ${lead.message.slice(0, 200)}${lead.message.length > 200 ? "..." : ""}`,
    ].join("\n");

    await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (err) {
    console.error("Telegram notification failed:", err);
  }
}

export async function POST(request: Request) {
  const body = await request.json();

  const { name, email, phone, topic, message } = body;

  if (!name || !email || !topic || !message) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  const supabase = createServerSupabaseClient();

  // AI classification + Supabase insert in parallel-ish flow
  const priority = await classifyLead(topic, message);

  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      name,
      email,
      phone: phone || null,
      topic,
      message,
      status: "new",
      priority,
    })
    .select()
    .single();

  if (error) {
    console.error("Supabase insert error:", error);
    return NextResponse.json(
      { error: "Failed to save lead" },
      { status: 500 }
    );
  }

  // Telegram — await to ensure it completes before function exits
  await sendTelegramNotification({ name, email, topic, priority, message });

  return NextResponse.json({ success: true, lead });
}
