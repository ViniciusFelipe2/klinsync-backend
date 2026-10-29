import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from "@aws-sdk/client-cost-explorer";
import { DescribeInstanceStatusCommand, DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import type { Config } from "../config.js";

/* ------------------------------------------------ Tipos ------------------------------------------------ */

export type Ponto = { t: number; v: number };

export type StatusCheck = "ok" | "comprometido" | "inicializando" | "indisponivel" | "desconhecido";

export type InstanciaInfo = {
  id: string;
  nome: string;
  tipo: string;
  estado: string;
  az: string | null;
  ipPrivado: string | null;
  ipPublico: string | null;
  iniciadaEm: string | null;
  /** Famílias T (t3, t4g…) têm créditos de CPU: sem crédito a instância é limitada. */
  burstavel: boolean;
  statusInstancia: StatusCheck;
  statusSistema: StatusCheck;
  eventosAgendados: { codigo: string; descricao: string; inicio: string | null }[];
};

export type SerieInstancia = {
  cpu: Ponto[];
  redeEntrada: Ponto[];
  redeSaida: Ponto[];
  creditos: Ponto[];
  /** Só existem com o CloudWatch Agent instalado na instância. */
  memoria: Ponto[];
  disco: Ponto[];
  falhaStatus: Ponto[];
};

export type AlarmeCw = {
  nome: string;
  estado: "OK" | "ALARM" | "INSUFFICIENT_DATA";
  motivo: string;
  atualizadoEm: string | null;
  metrica: string | null;
};

export type Infra = {
  instancias: InstanciaInfo[];
  series: Record<string, SerieInstancia>;
  alarmes: AlarmeCw[];
  periodoSegundos: number;
};

export type Custos = {
  moeda: "USD";
  mesAtual: { inicio: string; fim: string; total: number; diasDecorridos: number; diasNoMes: number };
  mesAnterior: { total: number; mesmoPeriodo: number };
  /** Total previsto até o fim do mês (Cost Explorer). */
  previsaoFimMes: number | null;
  hoje: number;
  mediaDiaria7d: number;
  diario: { dia: string; valor: number }[];
  porServico: { servico: string; valor: number; anterior: number }[];
  atualizadoEm: string;
};

export interface Monitor {
  readonly modo: "aws" | "demo";
  infra(horas: number): Promise<Infra>;
  custos(): Promise<Custos>;
}

/** Falha de leitura na AWS, já classificada para o painel explicar o que falta configurar. */
export class MonitorIndisponivel extends Error {
  constructor(
    readonly motivo: "credenciais" | "permissao" | "erro",
    mensagem: string,
    readonly acao?: string,
  ) {
    super(mensagem);
  }
}

export function classificarErroAws(err: unknown, acao: string): MonitorIndisponivel {
  const e = err as { name?: string; Code?: string; message?: string };
  const nome = e.name ?? e.Code ?? "";
  if (/Credential|CredentialsProviderError|ExpiredToken|UnrecognizedClient|InvalidClientTokenId|AuthFailure|SignatureDoesNotMatch/i.test(nome + (e.message ?? ""))) {
    return new MonitorIndisponivel("credenciais", "Sem credenciais AWS válidas neste servidor.", "Anexe a role de observabilidade à EC2 (ou configure as credenciais no ambiente local).");
  }
  if (/AccessDenied|UnauthorizedOperation|not authorized|OptInRequired/i.test(nome + (e.message ?? ""))) {
    return new MonitorIndisponivel("permissao", `Sem permissão para ${acao}.`, `Conceda a permissão IAM necessária (${acao}). Veja tf-ec2/iam.tf.`);
  }
  return new MonitorIndisponivel("erro", `Não foi possível consultar a AWS (${nome || "erro"}).`);
}

/* ------------------------------------------------ AWS ------------------------------------------------ */

const burstavel = (tipo: string) => /^t\d/.test(tipo);

const statusDe = (v: string | undefined): StatusCheck =>
  v === "ok" ? "ok" : v === "impaired" ? "comprometido" : v === "initializing" ? "inicializando" : v === "insufficient-data" || v === "not-applicable" ? "indisponivel" : "desconhecido";

/** Resolução (s) que cabe no período sem gerar séries enormes. A métrica básica do EC2 é de 5 em 5 min. */
export function passoDoPeriodo(horas: number): number {
  if (horas <= 6) return 300;
  if (horas <= 24) return 600;
  return 1800;
}

export function criarMonitorAws(config: Config): Monitor {
  const region = config.AWS_REGION;
  const ec2 = new EC2Client({ region });
  const cw = new CloudWatchClient({ region });
  const ce = new CostExplorerClient({ region: "us-east-1" }); // o Cost Explorer só existe em us-east-1
  const prefixo = config.MONITOR_NOME_PREFIXO;

  async function listarInstancias(): Promise<InstanciaInfo[]> {
    const r = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:Name", Values: [`${prefixo}*`] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] },
        ],
      }),
    );
    const base = (r.Reservations ?? []).flatMap((x) => x.Instances ?? []);
    const ids = base.map((i) => i.InstanceId!).filter(Boolean);
    const status = new Map<string, { i: string; s: string; ev: InstanciaInfo["eventosAgendados"] }>();
    if (ids.length > 0) {
      const st = await ec2.send(new DescribeInstanceStatusCommand({ InstanceIds: ids, IncludeAllInstances: true }));
      for (const s of st.InstanceStatuses ?? []) {
        status.set(s.InstanceId!, {
          i: s.InstanceStatus?.Status ?? "",
          s: s.SystemStatus?.Status ?? "",
          ev: (s.Events ?? []).map((e) => ({
            codigo: e.Code ?? "evento",
            descricao: e.Description ?? "",
            inicio: e.NotBefore ? e.NotBefore.toISOString() : null,
          })),
        });
      }
    }
    return base
      .map((i): InstanciaInfo => {
        const st = status.get(i.InstanceId!);
        return {
          id: i.InstanceId!,
          nome: i.Tags?.find((t) => t.Key === "Name")?.Value ?? i.InstanceId!,
          tipo: i.InstanceType ?? "?",
          estado: i.State?.Name ?? "desconhecido",
          az: i.Placement?.AvailabilityZone ?? null,
          ipPrivado: i.PrivateIpAddress ?? null,
          ipPublico: i.PublicIpAddress ?? null,
          iniciadaEm: i.LaunchTime ? i.LaunchTime.toISOString() : null,
          burstavel: burstavel(i.InstanceType ?? ""),
          statusInstancia: st ? statusDe(st.i) : "desconhecido",
          statusSistema: st ? statusDe(st.s) : "desconhecido",
          eventosAgendados: st?.ev ?? [],
        };
      })
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  async function metricas(instancias: InstanciaInfo[], horas: number, passo: number): Promise<Record<string, SerieInstancia>> {
    const fim = new Date();
    const inicio = new Date(fim.getTime() - horas * 3600_000);
    const queries: MetricDataQuery[] = [];
    const mapa = new Map<string, { id: string; campo: keyof SerieInstancia }>();
    const add = (idx: number, campo: keyof SerieInstancia, ns: string, nome: string, dims: { Name: string; Value: string }[], stat: string) => {
      const qid = `q${idx}_${campo.toLowerCase()}`;
      mapa.set(qid, { id: instancias[idx]!.id, campo });
      queries.push({ Id: qid, MetricStat: { Metric: { Namespace: ns, MetricName: nome, Dimensions: dims }, Period: passo, Stat: stat }, ReturnData: true });
    };
    instancias.forEach((inst, idx) => {
      if (inst.estado !== "running") return;
      const d = [{ Name: "InstanceId", Value: inst.id }];
      add(idx, "cpu", "AWS/EC2", "CPUUtilization", d, "Average");
      add(idx, "redeEntrada", "AWS/EC2", "NetworkIn", d, "Sum");
      add(idx, "redeSaida", "AWS/EC2", "NetworkOut", d, "Sum");
      add(idx, "falhaStatus", "AWS/EC2", "StatusCheckFailed", d, "Maximum");
      if (inst.burstavel) add(idx, "creditos", "AWS/EC2", "CPUCreditBalance", d, "Average");
      add(idx, "memoria", "CWAgent", "mem_used_percent", d, "Average");
      add(idx, "disco", "CWAgent", "disk_used_percent", [...d, { Name: "path", Value: "/" }], "Average");
    });

    const series: Record<string, SerieInstancia> = {};
    for (const i of instancias) {
      series[i.id] = { cpu: [], redeEntrada: [], redeSaida: [], creditos: [], memoria: [], disco: [], falhaStatus: [] };
    }
    for (let i = 0; i < queries.length; i += 400) {
      let token: string | undefined;
      do {
        const r = await cw.send(
          new GetMetricDataCommand({ MetricDataQueries: queries.slice(i, i + 400), StartTime: inicio, EndTime: fim, ScanBy: "TimestampAscending", NextToken: token }),
        );
        for (const res of r.MetricDataResults ?? []) {
          const alvo = mapa.get(res.Id ?? "");
          if (!alvo) continue;
          const ts = res.Timestamps ?? [];
          const vs = res.Values ?? [];
          const destino = series[alvo.id]![alvo.campo];
          for (let k = 0; k < ts.length; k++) destino.push({ t: ts[k]!.getTime(), v: vs[k]! });
        }
        token = r.NextToken;
      } while (token);
    }
    return series;
  }

  async function alarmes(): Promise<AlarmeCw[]> {
    const r = await cw.send(new DescribeAlarmsCommand({ AlarmTypes: ["MetricAlarm"], MaxRecords: 100 }));
    return (r.MetricAlarms ?? []).map((a) => ({
      nome: a.AlarmName ?? "?",
      estado: (a.StateValue as AlarmeCw["estado"]) ?? "INSUFFICIENT_DATA",
      motivo: a.StateReason ?? "",
      atualizadoEm: a.StateUpdatedTimestamp ? a.StateUpdatedTimestamp.toISOString() : null,
      metrica: a.MetricName ?? null,
    }));
  }

  return {
    modo: "aws",
    async infra(horas) {
      try {
        const instancias = await listarInstancias();
        const passo = passoDoPeriodo(horas);
        const [series, al] = await Promise.all([
          instancias.length ? metricas(instancias, horas, passo) : Promise.resolve({}),
          alarmes().catch(() => [] as AlarmeCw[]), // alarmes são opcionais: sem permissão não derruba o painel
        ]);
        return { instancias, series, alarmes: al, periodoSegundos: passo };
      } catch (err) {
        if (err instanceof MonitorIndisponivel) throw err;
        throw classificarErroAws(err, "ec2:DescribeInstances, ec2:DescribeInstanceStatus e cloudwatch:GetMetricData");
      }
    },
    async custos() {
      try {
        return await consultarCustos(ce);
      } catch (err) {
        throw classificarErroAws(err, "ce:GetCostAndUsage e ce:GetCostForecast");
      }
    },
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const soma = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function consultarCustos(ce: CostExplorerClient): Promise<Custos> {
  const agora = new Date();
  const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
  const inicioAnterior = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  const amanha = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() + 1));
  const fimMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 1));
  const diasNoMes = Math.round((fimMes.getTime() - inicioMes.getTime()) / 86400_000);
  const diasDecorridos = agora.getUTCDate();

  const dias: { dia: string; servicos: Map<string, number> }[] = [];
  let token: string | undefined;
  do {
    const r = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: iso(inicioAnterior), End: iso(amanha) },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        NextPageToken: token,
      }),
    );
    for (const p of r.ResultsByTime ?? []) {
      const servicos = new Map<string, number>();
      for (const g of p.Groups ?? []) servicos.set(g.Keys?.[0] ?? "Outros", Number(g.Metrics?.["UnblendedCost"]?.Amount ?? 0));
      dias.push({ dia: p.TimePeriod?.Start ?? "", servicos });
    }
    token = r.NextPageToken;
  } while (token);

  const totalDia = (d: { servicos: Map<string, number> }) => soma([...d.servicos.values()]);
  const doMes = dias.filter((d) => d.dia >= iso(inicioMes));
  const doAnterior = dias.filter((d) => d.dia < iso(inicioMes));
  const mesmoPeriodo = doAnterior.filter((d) => Number(d.dia.slice(8, 10)) <= diasDecorridos);

  const porServico = new Map<string, { valor: number; anterior: number }>();
  for (const d of doMes) for (const [s, v] of d.servicos) porServico.set(s, { valor: (porServico.get(s)?.valor ?? 0) + v, anterior: porServico.get(s)?.anterior ?? 0 });
  for (const d of mesmoPeriodo) for (const [s, v] of d.servicos) porServico.set(s, { valor: porServico.get(s)?.valor ?? 0, anterior: (porServico.get(s)?.anterior ?? 0) + v });

  let previsao: number | null = null;
  if (diasDecorridos < diasNoMes) {
    try {
      const f = await ce.send(
        new GetCostForecastCommand({ TimePeriod: { Start: iso(amanha), End: iso(fimMes) }, Metric: "UNBLENDED_COST", Granularity: "MONTHLY" }),
      );
      previsao = soma(doMes.map(totalDia)) + Number(f.Total?.Amount ?? 0);
    } catch {
      previsao = null; // início de conta/mês: o Cost Explorer ainda não tem histórico para prever
    }
  } else {
    previsao = soma(doMes.map(totalDia));
  }

  const diario = dias.slice(-30).map((d) => ({ dia: d.dia, valor: round(totalDia(d)) }));
  const ultimos7 = dias.slice(-8, -1); // sem o dia corrente, que ainda está incompleto
  return {
    moeda: "USD",
    mesAtual: { inicio: iso(inicioMes), fim: iso(fimMes), total: round(soma(doMes.map(totalDia))), diasDecorridos, diasNoMes },
    mesAnterior: { total: round(soma(doAnterior.map(totalDia))), mesmoPeriodo: round(soma(mesmoPeriodo.map(totalDia))) },
    previsaoFimMes: previsao === null ? null : round(previsao),
    hoje: round(doMes.length ? totalDia(doMes[doMes.length - 1]!) : 0),
    mediaDiaria7d: round(ultimos7.length ? soma(ultimos7.map(totalDia)) / ultimos7.length : 0),
    diario,
    porServico: [...porServico.entries()]
      .map(([servico, v]) => ({ servico, valor: round(v.valor), anterior: round(v.anterior) }))
      .filter((s) => s.valor > 0.005 || s.anterior > 0.005)
      .sort((a, b) => b.valor - a.valor),
    atualizadoEm: agora.toISOString(),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------ Dados fictícios (só dev) ------------------------------------------ */

/** Servidores e custos fictícios para ver o painel funcionando localmente. Nunca usado em produção. */
export function criarMonitorDemo(): Monitor {
  const agora = () => Date.now();
  const serie = (horas: number, passo: number, f: (i: number, n: number) => number): Ponto[] => {
    const n = Math.floor((horas * 3600) / passo);
    return Array.from({ length: n }, (_, i) => ({ t: agora() - (n - 1 - i) * passo * 1000, v: Math.max(0, f(i, n)) }));
  };
  const ruido = (i: number, a: number) => Math.sin(i * 0.7) * a + Math.cos(i * 1.9) * a * 0.5;
  const inst = (id: string, nome: string, tipo: string, ip: string, pub: string | null): InstanciaInfo => ({
    id, nome, tipo, estado: "running", az: "us-east-2a", ipPrivado: ip, ipPublico: pub,
    iniciadaEm: new Date(agora() - 19 * 86400_000).toISOString(), burstavel: true,
    statusInstancia: "ok", statusSistema: "ok", eventosAgendados: [],
  });
  return {
    modo: "demo",
    async infra(horas) {
      const passo = passoDoPeriodo(horas);
      const instancias = [
        inst("i-0demo0backend", "Klinsync-backend", "t3.small", "10.0.1.10", "3.140.0.10"),
        inst("i-0demo0db", "Klinsync-db", "t3.small", "10.0.2.10", null),
        inst("i-0demo0nat", "Klinsync-nat", "t3.nano", "10.0.1.5", "3.140.0.5"),
      ];
      const mk = (cpu: number, mem: number, discoIni: number, discoRitmo: number, cred: number): SerieInstancia => ({
        cpu: serie(horas, passo, (i, n) => cpu + ruido(i, 6) + (i > n - 4 ? cpu * 0.5 : 0)),
        redeEntrada: serie(horas, passo, (i) => 4e6 + ruido(i, 2e6) * 2),
        redeSaida: serie(horas, passo, (i) => 7e6 + ruido(i, 3e6) * 2),
        creditos: serie(horas, passo, (i, n) => cred - (i / n) * 20),
        memoria: serie(horas, passo, (i) => mem + ruido(i, 2)),
        disco: serie(horas, passo, (i, n) => discoIni + ((i / n) * discoRitmo * horas) / 24),
        falhaStatus: serie(horas, passo, () => 0),
      });
      return {
        instancias,
        series: {
          "i-0demo0backend": mk(34, 61, 41, 1.1, 118),
          "i-0demo0db": mk(22, 74, 63, 9, 140),
          "i-0demo0nat": mk(6, 28, 22, 0.1, 60),
        },
        alarmes: [
          { nome: "klinsync-backend-cpu-alta", estado: "OK", motivo: "Dentro do limite", atualizadoEm: new Date().toISOString(), metrica: "CPUUtilization" },
          { nome: "klinsync-db-disco", estado: "OK", motivo: "Dentro do limite", atualizadoEm: new Date().toISOString(), metrica: "disk_used_percent" },
        ],
        periodoSegundos: passo,
      };
    },
    async custos() {
      const hoje = new Date();
      const diario = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(hoje.getTime() - (29 - i) * 86400_000);
        return { dia: d.toISOString().slice(0, 10), valor: Math.round((1.9 + Math.sin(i / 3) * 0.25 + (i > 24 ? 0.6 : 0)) * 100) / 100 };
      });
      const dias = hoje.getUTCDate();
      const total = Math.round(diario.slice(-dias).reduce((a, b) => a + b.valor, 0) * 100) / 100;
      return {
        moeda: "USD",
        mesAtual: { inicio: `${hoje.toISOString().slice(0, 8)}01`, fim: "", total, diasDecorridos: dias, diasNoMes: 31 },
        mesAnterior: { total: 58.4, mesmoPeriodo: 17.9 },
        previsaoFimMes: Math.round((total / dias) * 31 * 100) / 100,
        hoje: diario[29]!.valor,
        mediaDiaria7d: 1.95,
        diario,
        porServico: [
          { servico: "Amazon Elastic Compute Cloud - Compute", valor: total * 0.52, anterior: 9.4 },
          { servico: "EC2 - Other", valor: total * 0.22, anterior: 3.1 },
          { servico: "Amazon Simple Storage Service", valor: total * 0.08, anterior: 0.7 },
          { servico: "Amazon CloudFront", valor: total * 0.05, anterior: 0.4 },
          { servico: "Amazon Virtual Private Cloud", valor: total * 0.13, anterior: 4.3 },
        ].map((s) => ({ ...s, valor: Math.round(s.valor * 100) / 100 })),
        atualizadoEm: new Date().toISOString(),
      };
    },
  };
}
