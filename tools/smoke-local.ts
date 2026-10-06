/**
 * Roteiro de verificação da API local (usa os usuários de `npm run local:seed`).
 *
 *   npm run local:smoke            # API em http://127.0.0.1:3000
 *
 * Percorre os fluxos principais dos 4 papéis, como o front faz (com a origem http://127.0.0.1:5173).
 * Deixa para trás um ciclo de giro no histórico; o check-in de teste é excluído no fim.
 */
const API = process.env["API_URL"] ?? "http://127.0.0.1:3000";
const ORIGEM = process.env["FRONT_ORIGIN"] ?? "http://127.0.0.1:5173";
const SENHA = process.env["SENHA_DEMO"] ?? "Demo#Senha2026";

type R = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
let falhas = 0;

async function chamar(metodo: string, caminho: string, opts: { token?: string; body?: unknown } = {}): Promise<R> {
  const res = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: {
      Origin: ORIGEM,
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const texto = await res.text();
  let body: unknown = texto;
  try {
    body = JSON.parse(texto);
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

function conferir(nome: string, ok: boolean, detalhe = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${nome}${!ok && detalhe ? `  → ${detalhe}` : ""}`);
  if (!ok) falhas += 1;
}

async function entrar(email: string): Promise<string> {
  const r = await chamar("POST", "/auth/login", { body: { email, senha: SENHA } });
  if (r.status !== 200) throw new Error(`login de ${email} falhou (${r.status}): ${JSON.stringify(r.body)}. Rode npm run local:seed?`);
  return r.body.accessToken as string;
}

const png = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]).toString("base64")}`;

console.log(`\nAPI: ${API}  |  origem do front: ${ORIGEM}\n`);

console.log("Infraestrutura");
const h = await chamar("GET", "/health");
conferir("health", h.status === 200 && h.body.status === "ok");
const pre = await fetch(`${API}/auth/login`, {
  method: "OPTIONS",
  headers: { Origin: ORIGEM, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
});
conferir("CORS libera a origem do front", pre.headers.get("access-control-allow-origin") === ORIGEM);
conferir("rota protegida exige login", (await chamar("GET", "/giro/salas")).status === 401);

console.log("\nLogin");
conferir("senha errada devolve 401 genérico", (await chamar("POST", "/auth/login", { body: { email: "giro@demo.local", senha: "Errada#1234567" } })).status === 401);
const master = await entrar("master@klinsync.local");
const admin = await entrar("admin@demo.local");
const giro = await entrar("giro@demo.local");
const checkin = await entrar("checkin@demo.local");
conferir("4 papéis entram com a senha de demonstração", true);
const dest = async (t: string) => (await chamar("GET", "/sessao/destino-inicial", { token: t })).body.destino;
conferir(
  "destino inicial por papel",
  (await dest(master)) === "/master" && (await dest(admin)) === "/hospital" && (await dest(giro)) === "/giro-sala" && (await dest(checkin)) === "/check-in",
);
const sessao = await chamar("GET", "/sessao", { token: giro });
conferir("sessão traz hospital e módulo do operador", sessao.body.tenant?.nome === "Hospital Demo" && sessao.body.features?.length === 1, JSON.stringify(sessao.body.features));

console.log("\nPainel master");
const dash = await chamar("GET", "/master/dashboard", { token: master });
conferir("dashboard lista hospitais, módulos e usuários", dash.status === 200 && dash.body.tenants.length >= 1 && dash.body.usuarios.length >= 4);
conferir("operador não acessa o painel master (403)", (await chamar("GET", "/master/dashboard", { token: giro })).status === 403);
conferir("postura de segurança", (await chamar("POST", "/master/seguranca/postura", { token: master, body: {} })).status === 200);
conferir("auditoria", (await chamar("POST", "/auditoria", { token: master, body: {} })).status === 200);

console.log("\nPainel do hospital");
const resumo = await chamar("GET", "/hospital/resumo", { token: admin });
conferir("resumo do hospital", resumo.status === 200 && resumo.body.salas.total === 3 && resumo.body.usuarios.total === 3, JSON.stringify(resumo.body.salas));
conferir("estatísticas de giro", (await chamar("POST", "/hospital/giro/estatisticas", { token: admin, body: {} })).status === 200);
conferir("operador não acessa o painel do hospital (403)", (await chamar("GET", "/hospital/resumo", { token: giro })).status === 403);

console.log("\nGiro de sala (operador)");
const salas = (await chamar("GET", "/giro/salas", { token: giro })).body as { id: string; nome: string; status_atual: string }[];
conferir("lista as 3 salas ativas", salas.length === 3);
const sala = salas.find((s) => s.status_atual === "livre")!;
const iniciar = (tipo: string) => chamar("POST", "/giro/etapas/iniciar", { token: giro, body: { salaId: sala.id, tipo } });
conferir("inicia enfermagem", (await iniciar("desmontagem")).status === 200);
conferir("limpeza inicia dentro do ciclo", (await iniciar("limpeza")).status === 200);
let abertos = (await chamar("GET", "/giro/eventos?abertos=true", { token: giro })).body as { id: string; tipo_evento: string }[];
const idEnf = abertos.find((e) => e.tipo_evento === "desmontagem")!.id;
const idLimp = abertos.find((e) => e.tipo_evento === "limpeza")!.id;
conferir(
  "enfermagem não fecha com a limpeza aberta (422)",
  (await chamar("POST", "/giro/etapas/finalizar", { token: giro, body: { eventoId: idEnf, cirurgiaProxima: "Cirurgia B" } })).status === 422,
);
conferir("finaliza a limpeza", (await chamar("POST", "/giro/etapas/finalizar", { token: giro, body: { eventoId: idLimp } })).status === 200);
conferir(
  "finaliza a enfermagem com a próxima cirurgia",
  (await chamar("POST", "/giro/etapas/finalizar", { token: giro, body: { eventoId: idEnf, cirurgiaProxima: "Cirurgia B" } })).status === 200,
);
const depois = ((await chamar("GET", "/giro/salas", { token: giro })).body as { id: string; status_atual: string; cirurgia_atual: string }[]).find((s) => s.id === sala.id)!;
conferir("sala volta a livre com a próxima cirurgia", depois.status_atual === "livre" && depois.cirurgia_atual === "Cirurgia B", JSON.stringify(depois));
abertos = (await chamar("GET", "/giro/eventos?abertos=true", { token: giro })).body;
conferir("nenhuma etapa em aberto", abertos.length === 0);
const par = await chamar("POST", "/giro/paradas/iniciar", { token: giro, body: { salaId: sala.id } });
const aberta = (await chamar("GET", "/giro/paradas?abertas=true", { token: giro })).body as { id: string }[];
conferir("marca e libera sala parada", par.status === 200 && (await chamar("POST", "/giro/paradas/finalizar", { token: giro, body: { paradaId: aberta[0]!.id } })).status === 200);
const reserva = await chamar("POST", "/giro/reservas/reservar", { token: giro, body: { salaId: sala.id, deviceId: "smoke-tablet" } });
const liberou = await chamar("POST", "/giro/reservas/liberar", { token: giro, body: { salaId: sala.id, deviceId: "smoke-tablet" } });
conferir("vínculo sala e tablet", reserva.body.reservada === true && liberou.status === 200);

console.log("\nCheck-in de cirurgiões");
const ci = await chamar("POST", "/checkins", { token: checkin, body: { doctorName: "Dr. Teste Local", photoBase64: png } });
conferir("registra check-in com foto", ci.status === 200 && ci.body.doctor_name === "Dr. Teste Local", JSON.stringify(ci.body));
const lista = await chamar("POST", "/checkins/listar", { token: checkin, body: { pagina: 1, porPagina: 20 } });
conferir("aparece no painel (total e hoje)", lista.status === 200 && lista.body.total >= 1 && lista.body.hoje >= 1);
const url = await chamar("POST", "/checkins/foto-url", { token: checkin, body: { id: ci.body.id } });
const foto = url.status === 200 ? await fetch(url.body.url) : null;
conferir(
  "foto abre pela URL assinada",
  !!foto && foto.status === 200 && (foto.headers.get("content-type") ?? "").startsWith("image/"),
  url.status === 200 ? String(foto?.status) : JSON.stringify(url.body),
);
conferir("admin do hospital vê o check-in no painel", (await chamar("POST", "/hospital/checkins", { token: admin, body: { pagina: 1, porPagina: 20 } })).body.total >= 1);
conferir("exclui o check-in de teste", (await chamar("POST", "/checkins/excluir", { token: checkin, body: { id: ci.body.id } })).status === 200);

console.log("\nMFA");
const enroll = await chamar("POST", "/auth/mfa/enroll", { token: master, body: { friendlyName: "Smoke" } });
conferir("gera QR code do autenticador", enroll.status === 200 && String(enroll.body.qr).startsWith("data:image/png"));
if (enroll.status === 200) await chamar("DELETE", `/auth/mfa/factors/${enroll.body.id}`, { token: master }); // não deixa cadastro pela metade

console.log(falhas === 0 ? "\nTudo certo: todos os fluxos principais funcionam.\n" : `\n${falhas} verificação(ões) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
