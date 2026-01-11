import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  AI: any;
  SESSIONS: any;
  DB: any;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors());

app.get("/", (c) => c.json({ message: "Crisis Counselor API Running" }));

/**
 * START SESSION
 * - Generate sessionId in the Worker
 * - Use sessionId as the Durable Object name (idFromName(sessionId))
 * - Pass sessionId into DO init so DO and DB use same id
 */
app.post("/api/session/start", async (c) => {
  const { userId, scenarioType } = await c.req.json();

  const sessionId = crypto.randomUUID();

  const doId = c.env.SESSIONS.idFromName(sessionId);
  const stub = c.env.SESSIONS.get(doId);

  const response = await stub.fetch("http://do/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, scenarioType, sessionId }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return c.json({ error: "DO init failed", details: text }, 500);
  }

  const data = await response.json(); // { sessionId, initialMessage }

  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, scenario_type, started_at) VALUES (?, ?, ?, ?)"
  )
    .bind(sessionId, userId, scenarioType, Date.now())
    .run();

  return c.json({
    sessionId,
    initialMessage: data.initialMessage,
  });
});

/**
 * SEND MESSAGE
 * - Use sessionId to locate DO (same DO as start/end)
 * - Persist both counselor and client messages in DO history + D1
 */
app.post("/api/session/message", async (c) => {
  const { sessionId, message } = await c.req.json();

  const doId = c.env.SESSIONS.idFromName(sessionId);
  const stub = c.env.SESSIONS.get(doId);

  // store counselor message in DO
  await stub.fetch("http://do/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "counselor", message }),
  });

  // store counselor message in D1
  await c.env.DB.prepare(
    "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
  )
    .bind(sessionId, "counselor", message)
    .run();

  // fetch history from DO
  const historyResponse = await stub.fetch("http://do/history");
  const { history } = await historyResponse.json();

  const scenarioType = await getScenarioType(c.env.DB, sessionId);

  // generate client response
  const aiResponse = await generateAIResponse(c.env.AI, history, scenarioType);

  // store client response in DO
  await stub.fetch("http://do/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "client", message: aiResponse }),
  });

  // store client response in D1
  await c.env.DB.prepare(
    "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
  )
    .bind(sessionId, "client", aiResponse)
    .run();

  return c.json({ clientResponse: aiResponse });
});

/**
 * END SESSION + FEEDBACK
 * - Pull full conversation history from the DO (source of truth for feedback)
 * - Generate feedback with AI
 * - Update session record + user_progress
 */
app.post("/api/session/end", async (c) => {
  const { sessionId, userId } = await c.req.json();

  const doId = c.env.SESSIONS.idFromName(sessionId);
  const stub = c.env.SESSIONS.get(doId);

  const endResponse = await stub.fetch("http://do/end", { method: "POST" });
  if (!endResponse.ok) {
    const text = await endResponse.text().catch(() => "");
    return c.json({ error: "DO end failed", details: text }, 500);
  }

  const { conversationHistory } = await endResponse.json();

  // Generate feedback from AI
  const feedback = await generateFeedback(c.env.AI, conversationHistory);

  await c.env.DB.prepare("UPDATE sessions SET ended_at = ?, feedback = ? WHERE id = ?")
    .bind(Date.now(), feedback, sessionId)
    .run();

  await updateUserProgress(c.env.DB, userId, feedback);

  return c.json({ feedback, conversationHistory });
});

async function generateAIResponse(
  ai: any,
  conversationHistory: Array<{ role: string; content: string }>,
  scenarioType: string
): Promise<string> {
  const systemPrompt = getScenarioPrompt(scenarioType);

  // Map your DO roles -> LLM roles
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((msg) => ({
      role: msg.role === "counselor" ? "user" : "assistant",
      content: msg.content,
    })),
  ];

  const response = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages,
    max_tokens: 256,
    temperature: 0.7,
  });

  return response.response || "I... I'm not sure what to say.";
}

async function generateFeedback(
  ai: any,
  conversationHistory: Array<{ role: string; content: string }>
): Promise<string> {
  const feedbackPrompt = `You are an expert crisis counseling supervisor. Analyze this conversation and provide detailed feedback.

Evaluate on: Active Listening, Safety Assessment, Empathy, De-escalation, Resource Connection.

Provide:
- Overall score (1-10)
- Specific strengths with examples
- Areas for improvement with suggestions
- One key takeaway

Conversation:
${conversationHistory.map((msg) => `${msg.role}: ${msg.content}`).join("\n")}`;

  const response = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: feedbackPrompt }],
    max_tokens: 1024,
    temperature: 0.3,
  });

  return response.response || "Feedback generation failed.";
}

function getScenarioPrompt(scenarioType: string): string {
  const prompts: Record<string, string> = {
    suicidal:
      "You are simulating a college student with suicidal ideation. Express hopelessness but show ambivalence. Respond authentically to counselor approach. If they show empathy and safety planning, become more open. If dismissive, withdraw.",
    anxiety:
      "You are experiencing a panic attack. Describe physical symptoms (chest tight, can't breathe). If counselor uses grounding techniques, symptoms ease. If they rush, anxiety intensifies.",
    grief:
      "You're struggling with grief 3 months after losing someone. Can't accept it's real. Feel guilty and angry. If counselor validates without fixing, open up. If they use platitudes, shut down.",
    academic:
      "You're having a crisis about academic failure and parental expectations. Self-worth tied to grades. If counselor separates worth from grades, see alternatives. If not, spiral deeper.",
  };

  return prompts[scenarioType] || prompts.anxiety;
}

async function getScenarioType(db: any, sessionId: string): Promise<string> {
  const result = await db
    .prepare("SELECT scenario_type FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first();

  return result?.scenario_type || "anxiety";
}

async function updateUserProgress(db: any, userId: string, feedback: string) {
  const scoreMatch = feedback.match(/score.*?(\d+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 5;

  const current = await db
    .prepare("SELECT * FROM user_progress WHERE user_id = ?")
    .bind(userId)
    .first();

  if (current) {
    const newTotal = current.total_sessions + 1;
    const prevAvg = current.average_score ?? 0;
    const prevTotal = current.total_sessions ?? 0;
    const newAvg = ((prevAvg * prevTotal) + score) / newTotal;

    await db
      .prepare(
        "UPDATE user_progress SET total_sessions = ?, average_score = ?, last_session_at = ? WHERE user_id = ?"
      )
      .bind(newTotal, newAvg, Date.now(), userId)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO user_progress (user_id, total_sessions, average_score, last_session_at, scenarios_completed) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(userId, 1, score, Date.now(), "[]")
      .run();
  }
}

/**
 * DURABLE OBJECT
 * - Stores conversation history and session data
 * - Uses the DO instance name (sessionId) as the stable identity
 */
export class SessionDurableObject {
  private state: any;
  private conversationHistory: Array<{ role: string; content: string }> = [];
  private sessionData: any = null;

  constructor(state: any, _env: any) {
    this.state = state;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/init":
        return this.initSession(request);
      case "/message":
        return this.handleMessage(request);
      case "/end":
        return this.endSession(request);
      case "/history":
        return this.getHistory();
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  async initSession(request: Request) {
    const { userId, scenarioType, sessionId } = await request.json();

    this.sessionData = {
      id: sessionId, // IMPORTANT: use worker-generated sessionId
      userId,
      scenarioType,
      startedAt: Date.now(),
    };

    this.conversationHistory = [];

    await this.state.storage.put("sessionData", this.sessionData);
    await this.state.storage.put("conversationHistory", this.conversationHistory);

    return new Response(
      JSON.stringify({
        sessionId: this.sessionData.id,
        initialMessage: this.getInitialMessage(scenarioType),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  async handleMessage(request: Request) {
    const { role, message } = await request.json();

    const history =
      ((await this.state.storage.get("conversationHistory")) as Array<{
        role: string;
        content: string;
      }>) || [];

    history.push({ role, content: message });

    await this.state.storage.put("conversationHistory", history);

    return new Response(
      JSON.stringify({
        success: true,
        messageCount: history.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  async endSession(_request: Request) {
    const sessionData = (await this.state.storage.get("sessionData")) as any;
    const history =
      ((await this.state.storage.get("conversationHistory")) as Array<{
        role: string;
        content: string;
      }>) || [];

    // Be resilient: don't throw if sessionData missing
    const startedAt = sessionData?.startedAt ?? Date.now();
    const id = sessionData?.id ?? null;

    return new Response(
      JSON.stringify({
        sessionId: id,
        conversationHistory: history,
        duration: Date.now() - startedAt,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  async getHistory() {
    const history =
      ((await this.state.storage.get("conversationHistory")) as Array<{
        role: string;
        content: string;
      }>) || [];

    return new Response(JSON.stringify({ history }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  getInitialMessage(scenarioType: string): string {
    const scenarios: Record<string, string> = {
      suicidal:
        "I... I don't know if I can keep doing this anymore. Everything feels so heavy.",
      anxiety:
        "I can't breathe... my chest is tight and I feel like something terrible is about to happen.",
      grief:
        "It's been three months since they died and I still can't accept it. I don't know how to go on.",
      academic:
        "I failed another exam. My parents are going to be so disappointed. Maybe I should just drop out.",
    };

    return scenarios[scenarioType] || scenarios.anxiety;
  }
}

export default app;