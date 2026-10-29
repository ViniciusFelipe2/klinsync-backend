import type { Custos, Infra, InstanciaInfo, Ponto } from "../services/monitor.js";

export type Severidade = "critico" | "aviso" | "info";

export type Alerta = {
  id: string;
  severidade: Severidade;
  categoria: "servidor" | "aplicacao" | "banco" | "custo" | "observabilidade";
  titulo: string;
  detalhe: string;
  recomendacao: string;
  recurso?: string;
};

export type ResumoApp = { requisicoes: number; erros5xx: number; erros4xx: number; latenciaMediaMs: number; lentas: number };
export type ResumoBanco = { conexoes: number; maxConexoes: number } | null;

export type EntradaSaude = {
  agora: number;
  infra: Infra | null;
  /** Janela recente (últimos minutos) da API. */
  app: ResumoApp | null;
  banco: ResumoBanco;
  custos: Custos | null;
  orcamento?: number | undefined;
};

const MIN = 60_000;
const JANELA_RECENTE_MS = 20 * MIN;

/** Média dos pontos da janela recente (ou null se não houver dado). */
export function mediaRecente(serie: Ponto[], agora: number, janelaMs = JANELA_RECENTE_MS): number | null {
  const p = serie.filter((x) => x.t >= agora - janelaMs);
  return p.length ? p.reduce((a, b) => a + b.v, 0) / p.length : null;
}

export const ultimoValor = (serie: Ponto[]): number | null => (serie.length ? serie[serie.length - 1]!.v : null);

/** Inclinação por hora (regressão linear simples). */
export function inclinacaoPorHora(serie: Ponto[]): number | null {
  if (serie.length < 6) return null;
  const n = serie.length;
  const x = serie.map((p) => p.t / 3600_000);
  const y = serie.map((p) => p.v);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    den += (x[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

const fmtDias = (horas: number) => (horas < 48 ? `${Math.max(1, Math.round(horas))} h` : `${Math.round(horas / 24)} dias`);
const pct = (n: number) => `${Math.round(n)}%`;

export function avaliarSaude(e: EntradaSaude): Alerta[] {
  const alertas: Alerta[] = [];
  const add = (a: Alerta) => alertas.push(a);

  if (e.infra) avaliarServidores(e, e.infra, add);

  if (e.app && e.app.requisicoes > 0) {
    const taxa = (e.app.erros5xx / e.app.requisicoes) * 100;
    if (e.app.erros5xx >= 3 && taxa >= 5) {
      add({
        id: "app-erros-5xx",
        severidade: "critico",
        categoria: "aplicacao",
        titulo: `API com ${taxa.toFixed(1)}% de erros do servidor`,
        detalhe: `${e.app.erros5xx} de ${e.app.requisicoes} requisições recentes terminaram em erro 5xx.`,
        recomendacao: "Veja as rotas com mais erros na aba Aplicação e os logs do PM2 (pm2 logs). Se começou após um deploy, considere klinsync-rollback.",
      });
    } else if (e.app.erros5xx >= 2 && taxa >= 1) {
      add({
        id: "app-erros-5xx",
        severidade: "aviso",
        categoria: "aplicacao",
        titulo: `Erros de servidor acima do normal (${taxa.toFixed(1)}%)`,
        detalhe: `${e.app.erros5xx} de ${e.app.requisicoes} requisições recentes falharam com 5xx.`,
        recomendacao: "Confira a aba Aplicação para identificar a rota afetada.",
      });
    }
    if (e.app.requisicoes >= 20 && e.app.latenciaMediaMs >= 1000) {
      add({
        id: "app-latencia",
        severidade: "aviso",
        categoria: "aplicacao",
        titulo: `API lenta (média de ${Math.round(e.app.latenciaMediaMs)} ms)`,
        detalhe: `${e.app.lentas} respostas passaram de 1 s na janela recente.`,
        recomendacao: "Verifique CPU/memória do backend e conexões do banco; veja as rotas mais lentas na aba Aplicação.",
      });
    }
  }

  if (e.banco && e.banco.maxConexoes > 0) {
    const uso = (e.banco.conexoes / e.banco.maxConexoes) * 100;
    if (uso >= 75) {
      add({
        id: "banco-conexoes",
        severidade: uso >= 90 ? "critico" : "aviso",
        categoria: "banco",
        titulo: `Conexões do banco em ${pct(uso)} do limite`,
        detalhe: `${e.banco.conexoes} de ${e.banco.maxConexoes} conexões em uso.`,
        recomendacao: "Reduza DB_POOL_MAX por processo ou aumente max_connections no Postgres (klinsync-db-tune). Procure consultas presas.",
      });
    }
  }

  if (e.custos) avaliarCustos(e, e.custos, add);

  const ordem: Record<Severidade, number> = { critico: 0, aviso: 1, info: 2 };
  return alertas.sort((a, b) => ordem[a.severidade] - ordem[b.severidade]);
}

function avaliarServidores(e: EntradaSaude, infra: Infra, add: (a: Alerta) => void) {
  const semAgente: string[] = [];

  for (const inst of infra.instancias) {
    const s = infra.series[inst.id];
    const rec = inst.nome;

    if (inst.estado === "stopped" || inst.estado === "stopping" || inst.estado === "shutting-down") {
      add({
        id: `srv-parada-${inst.id}`,
        severidade: "critico",
        categoria: "servidor",
        recurso: rec,
        titulo: `${rec} não está em execução (${inst.estado})`,
        detalhe: "A instância está parada ou sendo encerrada, então o serviço que depende dela está fora do ar.",
        recomendacao: "Se não foi intencional, inicie a instância no console EC2 e confira o histórico no CloudTrail.",
      });
      continue;
    }
    if (inst.estado !== "running") continue;

    avaliarStatus(inst, add);

    if (!s) continue;
    const cpu = mediaRecente(s.cpu, e.agora);
    if (cpu !== null && cpu >= 75) {
      add({
        id: `srv-cpu-${inst.id}`,
        severidade: cpu >= 90 ? "critico" : "aviso",
        categoria: "servidor",
        recurso: rec,
        titulo: `CPU alta em ${rec} (${pct(cpu)})`,
        detalhe: `Média de CPU nos últimos 20 minutos: ${pct(cpu)}.`,
        recomendacao: "Veja o que consome CPU (top / pm2 monit). Se for carga legítima, considere um tipo de instância maior.",
      });
    }

    if (inst.burstavel && s.creditos.length) {
      const saldo = ultimoValor(s.creditos)!;
      const queda = inclinacaoPorHora(s.creditos);
      if (saldo < 20) {
        add({
          id: `srv-creditos-${inst.id}`,
          severidade: saldo < 5 ? "critico" : "aviso",
          categoria: "servidor",
          recurso: rec,
          titulo: `Créditos de CPU quase no fim em ${rec} (${saldo.toFixed(0)})`,
          detalhe: "Sem créditos, instâncias da família T são limitadas à CPU de base e ficam lentas.",
          recomendacao: "Ative o modo unlimited ou migre para um tipo sem burst (m6i/c6i) se o uso é constante.",
        });
      } else if (queda !== null && queda < -0.5 && saldo / -queda < 24) {
        add({
          id: `srv-creditos-${inst.id}`,
          severidade: "aviso",
          categoria: "servidor",
          recurso: rec,
          titulo: `${rec} deve ficar sem créditos de CPU em ~${fmtDias(saldo / -queda)}`,
          detalhe: `Saldo atual ${saldo.toFixed(0)} e caindo ${(-queda).toFixed(1)} por hora.`,
          recomendacao: "Reduza a carga, ative o modo unlimited ou escolha um tipo de instância maior antes de esgotar.",
        });
      }
    }

    if (s.memoria.length === 0 && s.disco.length === 0) {
      semAgente.push(rec);
      continue;
    }

    const mem = mediaRecente(s.memoria, e.agora);
    if (mem !== null && mem >= 80) {
      add({
        id: `srv-mem-${inst.id}`,
        severidade: mem >= 92 ? "critico" : "aviso",
        categoria: "servidor",
        recurso: rec,
        titulo: `Memória alta em ${rec} (${pct(mem)})`,
        detalhe: `Uso médio de memória nos últimos 20 minutos: ${pct(mem)}. Perto do limite o Linux começa a matar processos (OOM).`,
        recomendacao: "Revise o número de workers do PM2 / shared_buffers do Postgres (klinsync-tune) ou aumente a RAM.",
      });
    }

    const disco = ultimoValor(s.disco);
    if (disco !== null && disco >= 80) {
      add({
        id: `srv-disco-${inst.id}`,
        severidade: disco >= 90 ? "critico" : "aviso",
        categoria: "servidor",
        recurso: rec,
        titulo: `Disco de ${rec} em ${pct(disco)}`,
        detalhe: "Disco cheio derruba o banco e impede o deploy.",
        recomendacao: "Limpe logs/backups antigos (journalctl --vacuum-size, pm2 flush) ou aumente o volume EBS.",
      });
    } else if (disco !== null) {
      const subida = inclinacaoPorHora(s.disco);
      if (subida !== null && subida > 0.02) {
        const horas = (100 - disco) / subida;
        if (horas < 14 * 24) {
          add({
            id: `srv-disco-tendencia-${inst.id}`,
            severidade: horas < 72 ? "critico" : "aviso",
            categoria: "servidor",
            recurso: rec,
            titulo: `Disco de ${rec} deve encher em ~${fmtDias(horas)}`,
            detalhe: `Hoje em ${pct(disco)}, crescendo ${subida.toFixed(2)} ponto(s) percentual(is) por hora.`,
            recomendacao: "Descubra o que cresce (du -xh / | sort -h) e planeje limpeza ou aumento do volume antes disso.",
          });
        }
      }
    }
  }

  if (semAgente.length) {
    add({
      id: "obs-sem-agente",
      severidade: "info",
      categoria: "observabilidade",
      titulo: "Memória e disco não estão sendo monitorados",
      detalhe: `Sem dados do CloudWatch Agent em: ${semAgente.join(", ")}.`,
      recomendacao: "Instale o agente (klinsync-backend/scripts/install-cwagent.sh) e confirme a permissão CloudWatchAgentServerPolicy na role da instância.",
    });
  }

  for (const a of infra.alarmes) {
    if (a.estado === "ALARM") {
      add({
        id: `cw-alarme-${a.nome}`,
        severidade: "critico",
        categoria: "servidor",
        titulo: `Alarme do CloudWatch disparado: ${a.nome}`,
        detalhe: a.motivo || "Alarme em estado ALARM.",
        recomendacao: "Abra o alarme no CloudWatch para ver a métrica e o horário em que passou do limite.",
      });
    }
  }
}

function avaliarStatus(inst: InstanciaInfo, add: (a: Alerta) => void) {
  if (inst.statusSistema === "comprometido") {
    add({
      id: `srv-status-sistema-${inst.id}`,
      severidade: "critico",
      categoria: "servidor",
      recurso: inst.nome,
      titulo: `Falha de hardware/rede da AWS em ${inst.nome}`,
      detalhe: "A verificação de status do sistema falhou (problema no host físico da AWS).",
      recomendacao: "Pare e inicie a instância (stop/start, não reboot) para migrá-la para outro host.",
    });
  }
  if (inst.statusInstancia === "comprometido") {
    add({
      id: `srv-status-instancia-${inst.id}`,
      severidade: "critico",
      categoria: "servidor",
      recurso: inst.nome,
      titulo: `${inst.nome} não responde (verificação de instância)`,
      detalhe: "O sistema operacional não está respondendo: kernel travado, disco cheio ou falta de memória.",
      recomendacao: "Veja o console da instância (Monitorar > Captura de tela / log do sistema) e reinicie se necessário.",
    });
  }
  for (const ev of inst.eventosAgendados) {
    add({
      id: `srv-evento-${inst.id}-${ev.codigo}`,
      severidade: "aviso",
      categoria: "servidor",
      recurso: inst.nome,
      titulo: `Manutenção agendada pela AWS em ${inst.nome} (${ev.codigo})`,
      detalhe: ev.descricao + (ev.inicio ? ` Início previsto: ${new Date(ev.inicio).toLocaleString("pt-BR")}.` : ""),
      recomendacao: "Reinicie a instância numa janela de baixo uso antes da data para controlar o impacto.",
    });
  }
}

function avaliarCustos(e: EntradaSaude, c: Custos, add: (a: Alerta) => void) {
  const usd = (n: number) => `US$ ${n.toFixed(2)}`;
  if (e.orcamento) {
    const projetado = c.previsaoFimMes ?? c.mesAtual.total;
    if (projetado >= e.orcamento) {
      add({
        id: "custo-orcamento",
        severidade: "critico",
        categoria: "custo",
        titulo: `Custo previsto (${usd(projetado)}) ultrapassa o orçamento de ${usd(e.orcamento)}`,
        detalhe: `Gasto até agora: ${usd(c.mesAtual.total)} em ${c.mesAtual.diasDecorridos} de ${c.mesAtual.diasNoMes} dias.`,
        recomendacao: "Veja os serviços que mais cresceram na aba Custos e desligue o que não for necessário.",
      });
    } else if (c.mesAtual.total >= e.orcamento * 0.8) {
      add({
        id: "custo-orcamento",
        severidade: "aviso",
        categoria: "custo",
        titulo: `Já foram consumidos ${pct((c.mesAtual.total / e.orcamento) * 100)} do orçamento do mês`,
        detalhe: `${usd(c.mesAtual.total)} de ${usd(e.orcamento)}.`,
        recomendacao: "Acompanhe a previsão de fim de mês na aba Custos.",
      });
    }
  }

  // Dia anterior completo contra a média dos 7 dias antes dele (o dia corrente ainda está incompleto).
  const hojeUtc = new Date(e.agora).toISOString().slice(0, 10);
  const dias = c.diario.filter((d) => d.dia < hojeUtc);
  if (dias.length >= 8) {
    const ontem = dias[dias.length - 1]!;
    const base = dias.slice(-8, -1);
    const media = base.reduce((a, b) => a + b.valor, 0) / base.length;
    if (ontem.valor >= 1 && ontem.valor > Math.max(media * 1.5, media + 1)) {
      add({
        id: "custo-anomalia",
        severidade: "aviso",
        categoria: "custo",
        titulo: `Custo de ${ontem.dia} fora do padrão (${usd(ontem.valor)})`,
        detalhe: `Média dos 7 dias anteriores: ${usd(media)}/dia.`,
        recomendacao: "Compare os serviços na aba Custos: tráfego de saída, NAT, IP elástico ocioso e volumes EBS esquecidos são as causas mais comuns.",
      });
    }
  }
  if (c.mesAnterior.total >= 5 && c.previsaoFimMes !== null && c.previsaoFimMes > c.mesAnterior.total * 1.3 && c.mesAtual.diasDecorridos >= 5) {
    add({
      id: "custo-tendencia",
      severidade: "info",
      categoria: "custo",
      titulo: "Custo do mês está acima do mês passado",
      detalhe: `Previsão ${usd(c.previsaoFimMes)} contra ${usd(c.mesAnterior.total)} no mês anterior.`,
      recomendacao: "Veja a comparação por serviço na aba Custos.",
    });
  }
}

export function saudeGeral(alertas: Alerta[]): "ok" | "atencao" | "critico" {
  if (alertas.some((a) => a.severidade === "critico")) return "critico";
  if (alertas.some((a) => a.severidade === "aviso")) return "atencao";
  return "ok";
}
