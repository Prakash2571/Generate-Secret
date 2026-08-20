import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OperationTracker, ShutdownManager } from '../src/utils/shutdown';
import { sleep } from '../src/utils/time';
import './helpers/setup';

describe('ShutdownManager', () => {
  it('runs steps in registration order', async () => {
    const manager = new ShutdownManager();
    const order: string[] = [];

    // The order the specification requires.
    manager.register({ name: 'stop scheduling', run: () => { order.push('scheduler'); } });
    manager.register({ name: 'drain operations', run: async () => { order.push('drain'); } });
    manager.register({ name: 'close browsers', run: () => { order.push('browser'); } });
    manager.register({ name: 'print report', run: () => { order.push('report'); } });
    manager.register({ name: 'write files', run: () => { order.push('files'); } });
    manager.register({ name: 'close mongodb', run: () => { order.push('mongo'); } });

    const code = await manager.shutdown('test');

    assert.deepEqual(order, ['scheduler', 'drain', 'browser', 'report', 'files', 'mongo']);
    assert.equal(code, 0);
  });

  it('signals in-flight work to stop before running any step', async () => {
    const manager = new ShutdownManager();
    let abortedDuringFirstStep: boolean | undefined;
    manager.register({
      name: 'observe',
      run: () => {
        abortedDuringFirstStep = manager.signal.aborted;
      },
    });

    await manager.shutdown('test');
    assert.equal(abortedDuringFirstStep, true);
    assert.equal(manager.isShuttingDown, true);
  });

  it('keeps going when a step fails, and reports a non-zero exit code', async () => {
    const manager = new ShutdownManager();
    const order: string[] = [];

    manager.register({ name: 'first', run: () => { order.push('first'); } });
    manager.register({
      name: 'explodes',
      run: () => {
        throw new Error('simulated failure');
      },
    });
    manager.register({ name: 'still runs', run: () => { order.push('still runs'); } });

    const code = await manager.shutdown('test');

    assert.deepEqual(order, ['first', 'still runs'], 'a failure must not abort the sequence');
    assert.equal(code, 1);
  });

  it('bounds a hanging step by its timeout', async () => {
    const manager = new ShutdownManager();
    let laterStepRan = false;

    manager.register({
      name: 'hangs forever',
      timeoutMs: 100,
      run: () => new Promise(() => undefined),
    });
    manager.register({ name: 'later', run: () => { laterStepRan = true; } });

    const started = Date.now();
    const code = await manager.shutdown('test');

    assert.ok(Date.now() - started < 2000, 'must not wait on the hung step');
    assert.equal(laterStepRan, true);
    assert.equal(code, 1);
  });

  it('is idempotent, so concurrent callers share one sequence', async () => {
    const manager = new ShutdownManager();
    let runs = 0;
    manager.register({ name: 'once only', run: () => { runs += 1; } });

    const [first, second] = await Promise.all([manager.shutdown('a'), manager.shutdown('b')]);
    const third = await manager.shutdown('c');

    assert.equal(runs, 1, 'steps must never run twice');
    assert.equal(first, second);
    assert.equal(third, first);
  });

  it('completes cleanly with no steps registered', async () => {
    assert.equal(await new ShutdownManager().shutdown('test'), 0);
  });
});

describe('OperationTracker', () => {
  it('tracks and releases in-flight operations', () => {
    const tracker = new OperationTracker();
    const finishDiscovery = tracker.begin('discovery');
    const finishValidation = tracker.begin('validation');

    assert.equal(tracker.count, 2);
    assert.deepEqual(tracker.activeLabels, ['discovery', 'validation']);

    finishDiscovery();
    assert.deepEqual(tracker.activeLabels, ['validation']);
    finishValidation();
    assert.equal(tracker.count, 0);
  });

  it('drain waits for work to finish', async () => {
    const tracker = new OperationTracker();
    const finish = tracker.begin('discovery');
    setTimeout(finish, 150);

    await tracker.drain(3000);
    assert.equal(tracker.count, 0);
  });

  it('drain gives up after its budget so shutdown cannot stall', async () => {
    const tracker = new OperationTracker();
    const finish = tracker.begin('stuck');

    const started = Date.now();
    await tracker.drain(200);
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 150, 'should have waited for its budget');
    assert.ok(elapsed < 2000, 'but must not wait indefinitely');
    assert.equal(tracker.count, 1, 'the operation is still running; we simply stop waiting');
    finish();
  });

  it('drain returns immediately when nothing is running', async () => {
    const tracker = new OperationTracker();
    const started = Date.now();
    await tracker.drain(5000);
    assert.ok(Date.now() - started < 200);
  });

  it('repeated release calls are harmless', async () => {
    const tracker = new OperationTracker();
    const finish = tracker.begin('discovery');
    finish();
    finish();
    assert.equal(tracker.count, 0);
    await sleep(1);
  });
});
