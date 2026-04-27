import type { GreenLevel, VerificationContract, VerificationEvidence } from "../state/types.ts";

const GREEN_ORDER: Record<GreenLevel, number> = {
	none: 0,
	targeted: 1,
	package: 2,
	workspace: 3,
	merge_ready: 4,
};

export interface GreenContractOutcome {
	requiredGreenLevel: GreenLevel;
	observedGreenLevel: GreenLevel;
	satisfied: boolean;
}

export function greenLevelSatisfies(observed: GreenLevel, required: GreenLevel): boolean {
	return GREEN_ORDER[observed] >= GREEN_ORDER[required];
}

export function evaluateGreenContract(contract: VerificationContract, evidence?: VerificationEvidence): GreenContractOutcome {
	const observedGreenLevel = evidence?.observedGreenLevel ?? "none";
	return {
		requiredGreenLevel: contract.requiredGreenLevel,
		observedGreenLevel,
		satisfied: greenLevelSatisfies(observedGreenLevel, contract.requiredGreenLevel),
	};
}

export function inferGreenLevelFromTask(success: boolean, contract: VerificationContract): GreenLevel {
	if (!success) return "none";
	if (contract.requiredGreenLevel === "none") return "none";
	return contract.allowManualEvidence ? contract.requiredGreenLevel : "targeted";
}

export function createVerificationEvidence(contract: VerificationContract, success: boolean, notes: string): VerificationEvidence {
	const observedGreenLevel = inferGreenLevelFromTask(success, contract);
	const outcome = evaluateGreenContract(contract, { requiredGreenLevel: contract.requiredGreenLevel, observedGreenLevel, satisfied: false, commands: [], notes });
	return {
		requiredGreenLevel: contract.requiredGreenLevel,
		observedGreenLevel,
		satisfied: outcome.satisfied,
		commands: contract.commands.map((cmd) => ({ cmd, status: "not_run" as const })),
		notes,
	};
}
