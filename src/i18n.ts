import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const namespace = "pi-crew";

const fallback = {
	"agent.requiresPrompt": "Agent requires prompt.",
	"agent.started": "Agent {state}.",
	"agent.id": "Agent ID: {id}",
	"agent.type": "Type: {type}",
	"agent.description": "Description: {description}",
	"agent.retrieveHint": "Use get_subagent_result to retrieve output. Do not duplicate this agent's work.",
	"agent.foregroundStatus": "Agent {id} {status}.",
	"agent.noOutput": "No output.",
	"result.requiresAgentId": "get_subagent_result requires agent_id.",
	"result.notFound": "Agent not found: {id}",
	"result.unrecoverable": "Subagent was interrupted before its durable run id was recorded; it cannot be recovered after restart.",
	"result.waitAborted": "Waiting for subagent result was aborted.",
	"result.stillRunning": "Agent is still running. Use wait=true or check again later.",
	"steer.noted": "Steering request noted for {id}.",
	"steer.unavailable": "Current default pi-crew backend is child-process, so mid-turn session.steer is not available yet.",
	"steer.cancelHint": "Use team cancel runId={runId} if the agent must be interrupted.",
} as const;

type Key = keyof typeof fallback;

const translations: Record<Locale, Partial<Record<Key, string>>> = {
	es: {
		"agent.requiresPrompt": "Agent requiere prompt.",
		"agent.started": "Agent {state}.",
		"agent.id": "ID del agente: {id}",
		"agent.type": "Tipo: {type}",
		"agent.description": "Descripción: {description}",
		"agent.retrieveHint": "Usa get_subagent_result para recuperar la salida. No dupliques el trabajo de este agente.",
		"agent.foregroundStatus": "Agent {id} {status}.",
		"agent.noOutput": "Sin salida.",
		"result.requiresAgentId": "get_subagent_result requiere agent_id.",
		"result.notFound": "Agente no encontrado: {id}",
		"result.unrecoverable": "El subagente fue interrumpido antes de registrar su ID de ejecución duradero; no se puede recuperar tras reiniciar.",
		"result.waitAborted": "Se canceló la espera del resultado del subagente.",
		"result.stillRunning": "El agente sigue ejecutándose. Usa wait=true o vuelve a comprobar más tarde.",
		"steer.noted": "Solicitud de dirección registrada para {id}.",
		"steer.unavailable": "El backend predeterminado actual de pi-crew es child-process, así que session.steer a mitad de turno aún no está disponible.",
		"steer.cancelHint": "Usa team cancel runId={runId} si hay que interrumpir el agente.",
	},
	fr: {
		"agent.requiresPrompt": "Agent nécessite un prompt.",
		"agent.started": "Agent {state}.",
		"agent.id": "ID de l’agent : {id}",
		"agent.type": "Type : {type}",
		"agent.description": "Description : {description}",
		"agent.retrieveHint": "Utilisez get_subagent_result pour récupérer la sortie. Ne dupliquez pas le travail de cet agent.",
		"agent.foregroundStatus": "Agent {id} {status}.",
		"agent.noOutput": "Aucune sortie.",
		"result.requiresAgentId": "get_subagent_result nécessite agent_id.",
		"result.notFound": "Agent introuvable : {id}",
		"result.unrecoverable": "Le sous-agent a été interrompu avant l’enregistrement de son ID d’exécution durable ; il ne peut pas être récupéré après redémarrage.",
		"result.waitAborted": "L’attente du résultat du sous-agent a été annulée.",
		"result.stillRunning": "L’agent est toujours en cours d’exécution. Utilisez wait=true ou réessayez plus tard.",
		"steer.noted": "Demande de pilotage enregistrée pour {id}.",
		"steer.unavailable": "Le backend pi-crew par défaut actuel est child-process, donc session.steer en milieu de tour n’est pas encore disponible.",
		"steer.cancelHint": "Utilisez team cancel runId={runId} si l’agent doit être interrompu.",
	},
	"pt-BR": {
		"agent.requiresPrompt": "Agent requer prompt.",
		"agent.started": "Agent {state}.",
		"agent.id": "ID do agente: {id}",
		"agent.type": "Tipo: {type}",
		"agent.description": "Descrição: {description}",
		"agent.retrieveHint": "Use get_subagent_result para recuperar a saída. Não duplique o trabalho deste agente.",
		"agent.foregroundStatus": "Agent {id} {status}.",
		"agent.noOutput": "Sem saída.",
		"result.requiresAgentId": "get_subagent_result requer agent_id.",
		"result.notFound": "Agente não encontrado: {id}",
		"result.unrecoverable": "O subagente foi interrompido antes que seu ID de execução durável fosse registrado; ele não pode ser recuperado após reiniciar.",
		"result.waitAborted": "A espera pelo resultado do subagente foi abortada.",
		"result.stillRunning": "O agente ainda está em execução. Use wait=true ou verifique novamente mais tarde.",
		"steer.noted": "Solicitação de orientação registrada para {id}.",
		"steer.unavailable": "O backend padrão atual do pi-crew é child-process, então session.steer no meio do turno ainda não está disponível.",
		"steer.cancelHint": "Use team cancel runId={runId} se o agente precisar ser interrompido.",
	},
};

let currentLocale: string | undefined;

function format(template: string, params: Params = {}): string {
	return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? `{${key}}`));
}

export function t(key: Key, params?: Params): string {
	const locale = currentLocale as Locale | undefined;
	const template = locale ? translations[locale]?.[key] : undefined;
	return format(template ?? fallback[key], params);
}

export function initI18n(pi: ExtensionAPI): () => void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", { namespace, defaultLocale: "en", fallback, translations });
	const unsubscribe = pi.events?.on?.("pi-core/i18n/localeChanged", (event: unknown) => {
		currentLocale = event && typeof event === "object" && "locale" in event ? String((event as { locale?: unknown }).locale ?? "") : undefined;
	});
	pi.events?.emit?.("pi-core/i18n/requestApi", { namespace, onApi(api: { getLocale?: () => string | undefined }) { currentLocale = api.getLocale?.(); } });
	return () => {
		unsubscribe?.();
	};
}
