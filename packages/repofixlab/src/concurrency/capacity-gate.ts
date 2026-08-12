/**
 * 脚本职责：为单类上游调用提供先进先出的固定容量闸门。
 * 输入边界：接收闸门名称、固定容量和成对取得释放操作。
 * 输出边界：只暴露容量快照，不执行上游调用。
 */

export interface CapacityGateSnapshot {
	readonly name: string;
	readonly capacity: number;
	readonly in_use: number;
	readonly waiting: number;
	readonly peak_in_use: number;
}

/**
 * 类职责：限制单类上游操作的同时占用数量。
 * 持有状态：保存冻结容量、当前占用、等待队列和峰值。
 * 协作边界：不识别任务状态且不访问持久化层。
 */
export class CapacityGate {
	private readonly gateName: string;
	private readonly capacityLimit: number;
	private readonly waiters: Array<() => void> = [];
	private inUse = 0;
	private peakInUse = 0;

	/**
	 * 函数职责：创建具有固定容量的命名闸门。
	 * 输入约束：名称必须非空，容量必须是正安全整数。
	 * 返回结果：创建当前占用为零的闸门。
	 * 失败语义：参数无效时抛出稳定配置错误。
	 */
	constructor(name: string, capacity: number) {
		if (name.trim().length === 0) throw new Error("invalid_capacity_gate_name");
		if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("invalid_capacity_gate_limit");
		this.gateName = name;
		this.capacityLimit = capacity;
	}

	/**
	 * 函数职责：按先进先出顺序取得一个上游调用名额。
	 * 输入约束：调用方必须在操作结束后执行一次 release。
	 * 返回结果：取得名额后 Promise 完成。
	 * 失败语义：等待期间不修改业务状态。
	 */
	async acquire(): Promise<void> {
		if (this.inUse < this.capacityLimit) {
			this.inUse += 1;
			this.peakInUse = Math.max(this.peakInUse, this.inUse);
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	/**
	 * 函数职责：释放一个名额并唤醒队首等待者。
	 * 输入约束：当前占用数量必须大于零。
	 * 返回结果：有等待者时转交名额，其余情况减少占用。
	 * 失败语义：无占用时释放抛出稳定状态错误。
	 */
	release(): void {
		if (this.inUse === 0) throw new Error("capacity_gate_release_without_acquire");
		const next = this.waiters.shift();
		if (next === undefined) {
			this.inUse -= 1;
			return;
		}
		next();
	}

	/**
	 * 函数职责：读取闸门当前容量统计。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回不可变数值快照。
	 * 失败语义：函数不产生失败和副作用。
	 */
	snapshot(): CapacityGateSnapshot {
		return {
			name: this.gateName,
			capacity: this.capacityLimit,
			in_use: this.inUse,
			waiting: this.waiters.length,
			peak_in_use: this.peakInUse,
		};
	}
}
