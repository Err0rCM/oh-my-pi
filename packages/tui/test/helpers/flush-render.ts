import type { VirtualTerminal } from "../virtual-terminal";

/** Drains a scheduled render: one microtask for ordering, then a render-interval tick. */
export async function flushRender(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(40);
	await term.flush();
}
