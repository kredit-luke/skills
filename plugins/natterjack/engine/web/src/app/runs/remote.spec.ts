import { describe, expect, it } from 'vitest';
import type { HostedLinkStatus, RemoteLinkLive, RemoteRunInfo, RunMeta } from '../../../../shared/api';
import { lastActivity as sharedLastActivity } from '../../../../shared/remote';
import {
  agoSeconds, cancelBlockedReason, commandPending, composerAction, composerHint, isOnline, planModeBlockedReason, lastActivity, linkLive, linkState, mergeRuns, offlineQueueHint, pendingLabel, pendingText,
  remoteAllows, remoteBanner, remoteBlockedReason, remoteControlLine, remoteTag, replyPending, stampLinks, upsertRunInList, upsertRunSplit, withListRemote,
} from './remote';
import type { LinkLive } from './remote';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
/** When this browser received the link list (a local stamp): just now, and a minute ago. */
const FRESH = NOW - 5_000;
const STALE = NOW - 60_000;

/** A list item's `remote` (no online / lastSeenAt: those are the link's). */
function remote(over: Partial<RemoteRunInfo> = {}): RemoteRunInfo {
  return { linkId: 'l1', label: 'Work laptop', enabled: true, pending: [], lastError: null, ...over };
}
function run(id: string, over: Partial<RunMeta> = {}): RunMeta {
  return { id, status: 'succeeded', startedAt: '2026-10-23T10:00:00.000Z', turnStartedAt: null, endedAt: null, ...over } as RunMeta;
}
/** The run's computer as DataService.remoteLive hands it out. */
function live(over: Partial<LinkLive> = {}): LinkLive {
  return { online: true, lastSeenAt: ago(5_000), enabled: true, label: 'Work laptop', ...over };
}
const ON = live();
const OFF = live({ online: false });
function entry(over: Partial<RemoteLinkLive> = {}, receivedAt = FRESH) {
  return { linkId: 'l1', label: 'Work laptop', enabled: true, online: true, lastSeenAt: ago(5_000), ...over, receivedAt };
}

describe('linkLive', () => {
  const fallback = { enabled: true, label: 'Old name' };
  it('is online when the pod said so, Remote control is on, and that arrived within ONLINE_MS', () => {
    expect(linkLive(entry(), fallback, NOW)).toEqual({ online: true, lastSeenAt: ago(5_000), enabled: true, label: 'Work laptop' });
    expect(linkLive(entry({}, NOW - 59_999), fallback, NOW).online).toBe(true);
  });
  it('is offline once the online flag is a minute old here, whatever it says', () => {
    expect(linkLive(entry({ online: true }, STALE), fallback, NOW).online).toBe(false);
  });
  it('is offline when the pod said offline or Remote control is off there', () => {
    expect(linkLive(entry({ online: false }), fallback, NOW).online).toBe(false);
    const off = linkLive(entry({ enabled: false }), fallback, NOW);
    expect(off.online).toBe(false);
    expect(off.enabled).toBe(false);
  });
  it('without an entry: offline, with the run\'s label and switch', () => {
    expect(linkLive(undefined, fallback, NOW)).toEqual({ online: false, lastSeenAt: null, enabled: true, label: 'Old name' });
    expect(linkLive(null, { enabled: false, label: 'x' }, NOW).enabled).toBe(false);
  });
  it('ignores lastSeenAt for online, so a browser clock off from the pod\'s gets it right', () => {
    // The pod's clock says an hour ago (or an hour ahead); the browser received online: true just now.
    expect(linkLive(entry({ lastSeenAt: ago(3_600_000) }), fallback, NOW).online).toBe(true);
    expect(linkLive(entry({ lastSeenAt: new Date(NOW + 3_600_000).toISOString() }, STALE), fallback, NOW).online).toBe(false);
  });
  it('stampLinks stamps every link of a payload with its arrival', () => {
    const links: RemoteLinkLive[] = [{ linkId: 'a', label: 'A', enabled: true, online: true, lastSeenAt: null }, { linkId: 'b', label: 'B', enabled: false, online: false, lastSeenAt: null }];
    expect(stampLinks(links, FRESH).map((l) => [l.linkId, l.receivedAt])).toEqual([['a', FRESH], ['b', FRESH]]);
  });
});

describe('isOnline', () => {
  it('is the link\'s online, and never while Remote control is off', () => {
    expect(isOnline(ON)).toBe(true);
    expect(isOnline(OFF)).toBe(false);
    expect(isOnline(live({ enabled: false }))).toBe(false);
    expect(isOnline(undefined)).toBe(false);
    expect(isOnline(null)).toBe(false);
  });
});

describe('remoteBanner', () => {
  it('is null for a run that is not mirrored', () => {
    expect(remoteBanner(run('a'), null, NOW)).toBeNull();
    expect(remoteBanner(run('a'), ON, NOW)).toBeNull();
  });
  it('says where it runs while online, by the link\'s label', () => {
    expect(remoteBanner(run('a', { status: 'running', remote: remote() }), ON, NOW)).toEqual({ tone: 'info', text: 'Running on Work laptop', seen: '' });
    expect(remoteBanner(run('a', { status: 'waiting', remote: remote() }), ON, NOW)).toEqual({ tone: 'info', text: 'Waiting for your answer · on Work laptop', seen: '' });
    expect(remoteBanner(run('a', { status: 'succeeded', remote: remote() }), ON, NOW)).toEqual({ tone: 'info', text: 'On Work laptop', seen: '' });
    expect(remoteBanner(run('a', { remote: remote({ label: 'Old name' }) }), live({ label: 'Home PC' }), NOW)!.text).toBe('On Home PC');
  });
  it('says the computer is offline, with when it was last seen (the link\'s) apart from the state', () => {
    expect(remoteBanner(run('a', { status: 'running', remote: remote() }), live({ online: false, lastSeenAt: ago(12 * 60_000) }), NOW)).toEqual({
      tone: 'warn', text: "Your computer is offline. Messages you queue wait until it's back.", seen: 'Last seen 12m ago.',
    });
    expect(remoteBanner(run('a', { remote: remote() }), live({ online: false, lastSeenAt: null }), NOW)).toEqual({
      tone: 'warn', text: "Your computer is offline. Messages you queue wait until it's back.", seen: '',
    });
  });
  it('without a link: offline from the run\'s own remote', () => {
    expect(remoteBanner(run('a', { remote: remote() }), null, NOW)!.tone).toBe('warn');
    expect(remoteBanner(run('a', { remote: remote({ enabled: false }) }), undefined, NOW)!.tone).toBe('off');
  });
  it('offline while waiting: says the answer waits, not that a queue does', () => {
    expect(remoteBanner(run('a', { status: 'waiting', remote: remote() }), OFF, NOW)!.text).toBe("Your computer is offline. You can answer when it's back.");
  });
  it('says Remote control is off (the link\'s switch), before offline', () => {
    expect(remoteBanner(run('a', { remote: remote() }), live({ enabled: false, online: false }), NOW)).toEqual({ tone: 'off', text: 'Remote control is off on Work laptop.', seen: '' });
  });
});

describe('withListRemote', () => {
  it('takes enabled, pending and lastError from DataService\'s copy, and drops the run\'s own online / lastSeenAt', () => {
    const pending = [{ id: 'p', kind: 'queue' as const, text: 'x', at: ago(1000), delivered: false }];
    const page = run('a', { status: 'running', remote: { ...remote(), online: true, lastSeenAt: ago(1000) } });
    const err = { kind: 'reply' as const, message: 'busy', at: ago(1000) };
    const list = [run('b', { remote: remote() }), run('a', { status: 'succeeded', remote: remote({ enabled: false, pending, lastError: err }) })];
    const got = withListRemote(page, list)!;
    expect(got.remote).toEqual({ linkId: 'l1', label: 'Work laptop', enabled: false, pending, lastError: err });
    expect(got.status).toBe('running'); // only remote comes from the list
  });
  it('falls back to the run\'s own remote when the list lacks it', () => {
    const page = run('a', { remote: remote() });
    expect(withListRemote(page, [])).toBe(page);
    expect(withListRemote(page, [run('a')])).toBe(page);
  });
  it('returns the same object when nothing changes, and a pod-local run or null as it is', () => {
    const r = remote();
    const page = run('a', { remote: r });
    expect(withListRemote(page, [run('a', { remote: r })])).toBe(page);
    const local = run('l');
    expect(withListRemote(local, [run('l', { remote: remote() })])).toBe(local);
    expect(withListRemote(null, [])).toBeNull();
  });
});

describe('a list row and the run page agree', () => {
  // The single-run payload the page loaded still says online (an old GET /api/runs/:id); the list
  // copy has no online at all. Both read the same link, so both show the same state.
  const listCopy = run('a', { status: 'running', remote: remote() });
  const pageCopy = run('a', { status: 'running', remote: { ...remote(), online: true, lastSeenAt: ago(1000) } });
  const page = withListRemote(pageCopy, [listCopy])!;

  it('offline: the row tags it offline and the page says offline', () => {
    const link = linkLive(entry({ online: true, lastSeenAt: ago(90_000) }, STALE), listCopy.remote!, NOW);
    expect(remoteTag(link, NOW)!.text).toBe('offline');
    expect(remoteBanner(page, link, NOW)!.tone).toBe('warn');
    expect(remoteBlockedReason(page, link)).toBe('Your computer is offline');
    expect(remoteAllows(page, 'cancel', link)).toBe(false);
    expect(remoteAllows(pageCopy, 'cancel', link)).toBe(false); // even the page's own copy, online: true and all
  });
  it('online: no tag on the row, and the page offers commands', () => {
    const link = linkLive(entry(), listCopy.remote!, NOW);
    expect(remoteTag(link, NOW)).toBeNull();
    expect(remoteBanner(page, link, NOW)!.tone).toBe('info');
    expect(remoteAllows(page, 'cancel', link)).toBe(true);
  });
});

describe('remoteAllows', () => {
  const all = ['reply', 'queue', 'queue-edit', 'queue-remove', 'queue-send', 'queue-auto', 'cancel', 'plan-mode'];
  const never = ['rename', 'verdict', 'flag', 'terminal', 'send-to-hosted', 'changes', 'watch-stop'];
  const pending = [
    { id: 'p-held', kind: 'queue' as const, text: 'x', at: ago(1000), delivered: false },
    { id: 'p-sent', kind: 'queue' as const, text: 'y', at: ago(1000), delivered: true },
    { id: 'p-reply', kind: 'reply' as const, text: 'z', at: ago(1000), delivered: false },
    { id: 'p-reply-sent', kind: 'reply' as const, text: 'z', at: ago(1000), delivered: true },
  ];

  it('allows everything on a run that is not mirrored', () => {
    for (const a of [...all, ...never]) expect(remoteAllows(run('a'), a, null)).toBe(true);
  });
  it('online: every command kind, nothing else', () => {
    const r = run('a', { remote: remote() });
    for (const a of all) expect(remoteAllows(r, a, ON)).toBe(true);
    for (const a of never) expect(remoteAllows(r, a, ON)).toBe(false);
  });
  it('offline: queue only, plus edit/remove of an undelivered pending queue', () => {
    const r = run('a', { remote: remote({ pending }) });
    expect(remoteAllows(r, 'queue', OFF)).toBe(true);
    for (const a of ['reply', 'queue-send', 'queue-auto', 'cancel', 'plan-mode', ...never]) expect(remoteAllows(r, a, OFF)).toBe(false);
    expect(remoteAllows(r, 'queue-edit', OFF, 'p-held')).toBe(true);
    expect(remoteAllows(r, 'queue-remove', OFF, 'p-held')).toBe(true);
    expect(remoteAllows(r, 'queue-edit', OFF, 'p-sent')).toBe(false);
    expect(remoteAllows(r, 'queue-remove', OFF, 'q-on-the-computer')).toBe(false);
    expect(remoteAllows(r, 'queue-edit', OFF)).toBe(false);
  });
  it('no link entry counts as offline', () => {
    const r = run('a', { remote: remote({ pending }) });
    expect(remoteAllows(r, 'reply', null)).toBe(false);
    expect(remoteAllows(r, 'queue-edit', undefined, 'p-held')).toBe(true);
  });
  it('online: a delivered but unacked pending queue can\'t be edited or removed', () => {
    const r = run('a', { remote: remote({ pending }) });
    expect(remoteAllows(r, 'queue-edit', ON, 'p-sent')).toBe(false);
    expect(remoteAllows(r, 'queue-remove', ON, 'p-sent')).toBe(false);
    expect(remoteAllows(r, 'queue-edit', ON, 'p-held')).toBe(true);
    expect(remoteAllows(r, 'queue-remove', ON, 'q-on-the-computer')).toBe(true);
  });
  it('a pending reply\'s id is not a held queue: forwarded online, refused offline, whether delivered or not', () => {
    const r = run('a', { remote: remote({ pending }) });
    expect(remoteAllows(r, 'queue-edit', ON, 'p-reply')).toBe(true);
    expect(remoteAllows(r, 'queue-remove', ON, 'p-reply-sent')).toBe(true);
    expect(remoteAllows(r, 'queue-edit', OFF, 'p-reply')).toBe(false);
    expect(remoteAllows(r, 'queue-remove', OFF, 'p-reply')).toBe(false);
  });
  it('Remote control off (the link\'s switch): nothing', () => {
    const r = run('a', { remote: remote({ pending }) });
    for (const a of [...all, ...never]) expect(remoteAllows(r, a, live({ enabled: false }), 'p-held')).toBe(false);
  });
});

describe('remoteTag', () => {
  it('is null for a run that is not mirrored, or an online computer', () => {
    expect(remoteTag(undefined, NOW)).toBeNull();
    expect(remoteTag(null, NOW)).toBeNull();
    expect(remoteTag(ON, NOW)).toBeNull();
  });
  it('says remote control off when it is, not offline', () => {
    expect(remoteTag(live({ enabled: false, online: false }), NOW)).toEqual({ text: 'remote control off', title: 'Remote control is off on Work laptop' });
  });
  it('says offline for an enabled computer that is offline, with the link\'s last seen', () => {
    expect(remoteTag(live({ online: false, lastSeenAt: ago(3 * 60_000) }), NOW)).toEqual({ text: 'offline', title: 'Your computer was last seen 3m ago' });
    expect(remoteTag(live({ online: false, lastSeenAt: null }), NOW)).toEqual({ text: 'offline', title: "Your computer hasn't synced yet" });
  });
});

describe('pendingLabel', () => {
  it('says whether the computer has it', () => {
    expect(pendingLabel({ delivered: false })).toBe('Waiting for your computer');
    expect(pendingLabel({ delivered: true })).toBe('Sent to your computer');
  });
});

describe('pendingText', () => {
  it('shows a reply or queue by its text, anything else by what it does', () => {
    expect(pendingText({ kind: 'queue', text: 'and add tests' })).toBe('and add tests');
    expect(pendingText({ kind: 'reply', text: 'yes' })).toBe('yes');
    expect(pendingText({ kind: 'reply' })).toBe('Reply');
    expect(pendingText({ kind: 'queue-edit', text: 'new text' })).toBe('Edit a queued message');
    expect(pendingText({ kind: 'cancel' })).toBe('Cancel');
    expect(pendingText({ kind: 'plan-mode' })).toBe('Plan mode setting');
  });
});

describe('remoteBlockedReason', () => {
  it('is null for the pod\'s own run and for an online computer', () => {
    expect(remoteBlockedReason(run('a'), null)).toBeNull();
    expect(remoteBlockedReason(run('a', { remote: remote() }), ON)).toBeNull();
  });
  it('says offline, or that Remote control is off there', () => {
    expect(remoteBlockedReason(run('a', { remote: remote() }), OFF)).toBe('Your computer is offline');
    expect(remoteBlockedReason(run('a', { remote: remote() }), null)).toBe('Your computer is offline');
    expect(remoteBlockedReason(run('a', { remote: remote() }), live({ enabled: false }))).toBe('Remote control is off on Work laptop');
  });
});

describe('commandPending / cancelBlockedReason / planModeBlockedReason', () => {
  const cmd = (kind: 'cancel' | 'plan-mode' | 'reply', delivered: boolean) => ({ id: 'c-' + kind, kind, at: ago(1000), delivered });

  it('commandPending: a command of that kind in pending, delivered or not', () => {
    expect(commandPending(run('a'), 'cancel')).toBe(false);
    expect(commandPending(run('a', { remote: remote({ pending: [cmd('cancel', false)] }) }), 'cancel')).toBe(true);
    expect(commandPending(run('a', { remote: remote({ pending: [cmd('cancel', true)] }) }), 'cancel')).toBe(true);
    expect(commandPending(run('a', { remote: remote({ pending: [cmd('reply', false)] }) }), 'cancel')).toBe(false);
  });
  it('null for the pod\'s own run, and for an online computer with nothing on its way', () => {
    expect(cancelBlockedReason(run('a', { status: 'running' }), null)).toBeNull();
    expect(planModeBlockedReason(run('a'), null)).toBeNull();
    expect(cancelBlockedReason(run('a', { status: 'running', remote: remote() }), ON)).toBeNull();
    expect(planModeBlockedReason(run('a', { remote: remote() }), ON)).toBeNull();
  });
  it('a cancel on its way disables Cancel, delivered or not; a plan-mode change disables plan mode', () => {
    for (const delivered of [false, true]) {
      const r = run('a', { status: 'running', remote: remote({ pending: [cmd('cancel', delivered)] }) });
      expect(cancelBlockedReason(r, ON)).toBe('Cancel sent to your computer');
      expect(planModeBlockedReason(r, ON)).toBeNull();
      const p = run('a', { remote: remote({ pending: [cmd('plan-mode', delivered)] }) });
      expect(planModeBlockedReason(p, ON)).toBe('Plan mode change sent to your computer');
      expect(cancelBlockedReason(p, ON)).toBeNull();
    }
  });
  it('offline or Remote control off says so first', () => {
    const pending = [cmd('cancel', false), cmd('plan-mode', false)];
    expect(cancelBlockedReason(run('a', { remote: remote({ pending }) }), OFF)).toBe('Your computer is offline');
    expect(planModeBlockedReason(run('a', { remote: remote() }), OFF)).toBe('Your computer is offline');
    expect(cancelBlockedReason(run('a', { remote: remote({ pending }) }), live({ enabled: false }))).toBe('Remote control is off on Work laptop');
    expect(planModeBlockedReason(run('a', { remote: remote() }), live({ enabled: false }))).toBe('Remote control is off on Work laptop');
  });
});

describe('composerAction', () => {
  it('a run of the pod\'s own: queue while running, reply between turns, nothing otherwise', () => {
    expect(composerAction(run('a', { status: 'running' }), null)).toBe('queue');
    for (const status of ['waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(composerAction(run('a', { status }), null)).toBe('reply');
    }
    expect(composerAction(run('a', { status: 'handedOff' }), null)).toBeNull();
  });
  it('a mirrored run online: the same as the pod\'s own', () => {
    expect(composerAction(run('a', { status: 'running', remote: remote() }), ON)).toBe('queue');
    expect(composerAction(run('a', { status: 'waiting', remote: remote() }), ON)).toBe('reply');
  });
  it('a mirrored run offline between turns: queue instead of reply, so the message waits for the computer', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(composerAction(run('a', { status, remote: remote() }), OFF)).toBe('queue');
    }
    expect(composerAction(run('a', { status: 'running', remote: remote() }), OFF)).toBe('queue');
  });
  it('a mirrored run offline and waiting: nothing, since a queued message there is never an answer', () => {
    expect(composerAction(run('a', { status: 'waiting', remote: remote() }), OFF)).toBeNull();
    expect(composerAction(run('a', { status: 'waiting', remote: remote() }), null)).toBeNull();
  });
  it('a reply on its way: no second reply between turns, queue still follows its rules while running', () => {
    const pending = (delivered: boolean) => [{ id: 'p', kind: 'reply' as const, text: 'yes', at: ago(1000), delivered }];
    for (const delivered of [false, true]) {
      expect(composerAction(run('a', { status: 'waiting', remote: remote({ pending: pending(delivered) }) }), ON)).toBeNull();
      expect(composerAction(run('a', { status: 'succeeded', remote: remote({ pending: pending(delivered) }) }), ON)).toBeNull();
    }
    expect(composerAction(run('a', { status: 'running', remote: remote({ pending: pending(true) }) }), ON)).toBe('queue');
    // A pending queue doesn't block a reply.
    expect(composerAction(run('a', { status: 'waiting', remote: remote({ pending: [{ id: 'q', kind: 'queue', text: 'x', at: ago(1000), delivered: false }] }) }), ON)).toBe('reply');
  });
  it('Remote control off there: nothing can be sent', () => {
    expect(composerAction(run('a', { status: 'succeeded', remote: remote() }), live({ enabled: false }))).toBeNull();
    expect(composerAction(run('a', { status: 'running', remote: remote() }), live({ enabled: false }))).toBeNull();
  });
});

describe('replyPending', () => {
  it('is true while a reply sits in pending, delivered or not', () => {
    expect(replyPending(run('a'))).toBe(false);
    expect(replyPending(run('a', { remote: remote() }))).toBe(false);
    expect(replyPending(run('a', { remote: remote({ pending: [{ id: 'p', kind: 'reply', at: ago(1000), delivered: true }] }) }))).toBe(true);
    expect(replyPending(run('a', { remote: remote({ pending: [{ id: 'p', kind: 'queue', text: 'x', at: ago(1000), delivered: false }] }) }))).toBe(false);
  });
});

describe('offlineQueueHint', () => {
  it('after a turn that ended, the queue goes out by itself on the computer', () => {
    expect(offlineQueueHint('succeeded')).toBe("Enter to queue · it goes to your computer when it's back and is sent there as your next reply.");
    expect(offlineQueueHint('failed')).toBe(offlineQueueHint('succeeded'));
  });
  it('after a cancel or interruption, it is held there until Send now', () => {
    expect(offlineQueueHint('cancelled')).toBe("Enter to queue · it goes to your computer when it's back and is held there until you press Send now, because the turn was cancelled.");
    expect(offlineQueueHint('interrupted')).toContain('held there until you press Send now, because the turn was interrupted.');
  });
});

describe('composerHint', () => {
  const held = { id: 'q1', kind: 'queue' as const, text: 'x', at: ago(1000), delivered: false };
  const sent = { id: 'q2', kind: 'queue' as const, text: 'y', at: ago(1000), delivered: true };
  const reply = { id: 'r1', kind: 'reply' as const, text: 'yes', at: ago(1000), delivered: false };
  const q = (id: string) => ({ id, text: 'x', at: ago(1000) });

  it('is null for a run that isn\'t mirrored, and for an online computer with nothing disabled', () => {
    expect(composerHint(run('a', { status: 'waiting' }), null)).toBeNull();
    expect(composerHint(run('a', { status: 'waiting', remote: remote({ pending: [held] }), queued: [q('q1')] } as Partial<RunMeta>), ON)).toBeNull();
  });
  it('Remote control off', () => {
    expect(composerHint(run('a', { remote: remote() }), live({ enabled: false }))).toBe('Remote control is off on Work laptop, so nothing can be sent to this run.');
  });
  it('offline: answering needs the computer while waiting (the banner says the rest), else what else does', () => {
    expect(composerHint(run('a', { status: 'waiting', remote: remote() }), OFF)).toBe('Answering needs your computer online.');
    const others = 'Plan mode, auto-send, Send now and messages already on your computer need it online.';
    expect(composerHint(run('a', { status: 'succeeded', remote: remote() }), OFF)).toBe(others);
    expect(composerHint(run('a', { status: 'running', remote: remote() }), null)).toBe(others);
  });
  it('offline and waiting: the hint doesn\'t repeat the banner', () => {
    const r = run('a', { status: 'waiting', remote: remote() });
    expect(composerHint(r, OFF)).not.toBe(remoteBanner(r, OFF, NOW)!.text);
    expect(remoteBanner(r, OFF, NOW)!.text).toContain("You can answer when it's back.");
    expect(composerHint(r, OFF)).not.toContain("when it's back");
  });
  it('a reply on its way', () => {
    expect(composerHint(run('a', { status: 'waiting', remote: remote({ pending: [reply] }) }), ON)).toBe('Sending to your computer…');
    expect(composerHint(run('a', { status: 'waiting', remote: remote({ pending: [reply] }) }), OFF)).toBe("Your reply goes to your computer when it's back.");
  });
  it('online, a queued message already sent to the computer can\'t be changed', () => {
    expect(composerHint(run('a', { status: 'running', remote: remote({ pending: [sent] }), queued: [q('q2')] } as Partial<RunMeta>), ON))
      .toBe("Messages already sent to your computer can't be changed here.");
  });
});

describe('mergeRuns / upsertRunInList / upsertRunSplit', () => {
  const at = (h: number) => `2026-10-23T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('lastActivity is the shared one: the newest of start, turn start and end', () => {
    expect(lastActivity).toBe(sharedLastActivity);
    expect(lastActivity({ startedAt: at(1), turnStartedAt: at(5), endedAt: at(3) })).toBe(at(5));
    expect(lastActivity({ startedAt: at(1), turnStartedAt: null, endedAt: null })).toBe(at(1));
  });
  it('merges mirrored runs in by last activity', () => {
    const local = [run('l2', { startedAt: at(9) }), run('l1', { startedAt: at(3) })];
    const mirrored = [run('m2', { startedAt: at(1), endedAt: at(10), remote: remote() }), run('m1', { startedAt: at(5), remote: remote() })];
    expect(mergeRuns(local, mirrored).map((r) => r.id)).toEqual(['m2', 'l2', 'm1', 'l1']);
  });
  it('keeps the pod-local run when a mirrored one has its id', () => {
    const merged = mergeRuns([run('x', { startedAt: at(2) })], [run('x', { startedAt: at(8), remote: remote() })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].remote).toBeUndefined();
  });
  it('without mirrored runs, keeps the server order', () => {
    const local = [run('b', { startedAt: at(1) }), run('a', { startedAt: at(2) })];
    expect(mergeRuns(local).map((r) => r.id)).toEqual(['b', 'a']);
    expect(mergeRuns(local, []).map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('upsert replaces in place, keeping remote, and prepends a new run', () => {
    const list = [run('a'), run('m', { remote: remote() }), run('c')];
    const next = upsertRunInList(list, run('m', { status: 'running', remote: remote({ pending: [] }) }));
    expect(next.map((r) => r.id)).toEqual(['a', 'm', 'c']);
    expect(next[1].status).toBe('running');
    expect(next[1].remote?.label).toBe('Work laptop');
    expect(upsertRunInList(list, run('n', { remote: remote() })).map((r) => r.id)).toEqual(['n', 'a', 'm', 'c']);
  });
  it('upsert never lets a mirrored copy replace a pod-local run; a local one replaces a mirrored one', () => {
    const list = [run('a', { status: 'succeeded' })];
    expect(upsertRunInList(list, run('a', { status: 'running', remote: remote() }))[0].remote).toBeUndefined();
    const mirroredFirst = [run('a', { remote: remote() })];
    expect(upsertRunInList(mirroredFirst, run('a'))[0].remote).toBeUndefined();
  });

  describe('upsertRunSplit keeps the pod\'s runs and the mirrored ones apart', () => {
    const local = [run('l1')];
    const mirrored = [run('m1', { remote: remote() })];

    it('a mirrored run goes into the mirrored list only', () => {
      const added = upsertRunSplit(local, mirrored, run('m2', { remote: remote() }));
      expect(added.local).toBe(local);
      expect(added.remote.map((r) => r.id)).toEqual(['m2', 'm1']);
      const updated = upsertRunSplit(local, mirrored, run('m1', { status: 'running', remote: remote() }));
      expect(updated.local).toBe(local);
      expect(updated.remote[0].status).toBe('running');
    });
    it('a mirrored copy of a pod-local run changes neither list', () => {
      const r = upsertRunSplit(local, mirrored, run('l1', { status: 'running', remote: remote() }));
      expect(r.local).toBe(local);
      expect(r.remote).toBe(mirrored);
    });
    it('a pod-local run goes into the local list only', () => {
      const r = upsertRunSplit(local, mirrored, run('l2'));
      expect(r.local.map((x) => x.id)).toEqual(['l2', 'l1']);
      expect(r.remote).toBe(mirrored);
    });
    it('a pod-local run with a mirrored run\'s id takes it out of the mirrored list', () => {
      const r = upsertRunSplit(local, mirrored, run('m1'));
      expect(r.local.map((x) => x.id)).toEqual(['m1', 'l1']);
      expect(r.local[0].remote).toBeUndefined();
      expect(r.remote).toEqual([]);
    });
  });
});

describe('Settings lines', () => {
  const rc = (over: Partial<HostedLinkStatus['remoteControl']>): HostedLinkStatus['remoteControl'] =>
    ({ on: true, state: 'connected', message: null, lastSyncAt: null, ...over });

  it('agoSeconds counts seconds under a minute, then defers to relTime', () => {
    expect(agoSeconds(ago(12_000), NOW)).toBe('12 s ago');
    expect(agoSeconds(new Date(NOW + 1000).toISOString(), NOW)).toBe('0 s ago');
    expect(agoSeconds(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(agoSeconds('nope', NOW)).toBe('');
  });
  it('remoteControlLine covers each state', () => {
    expect(remoteControlLine(rc({ lastSyncAt: ago(12_000) }), NOW)).toBe('Connected · last sync 12 s ago');
    expect(remoteControlLine(rc({}), NOW)).toBe('Connected');
    expect(remoteControlLine(rc({ state: 'connecting' }), NOW)).toBe('Connecting…');
    expect(remoteControlLine(rc({ state: 'refused', message: 'link token refused' }), NOW)).toBe('Refused: link token refused');
    expect(remoteControlLine(rc({ state: 'refused' }), NOW)).toBe('Refused');
    expect(remoteControlLine(rc({ state: 'error', message: 'Your hosted dashboard is on an older version' }), NOW)).toBe('Your hosted dashboard is on an older version');
    expect(remoteControlLine(rc({ state: 'error' }), NOW)).toBe('Something went wrong');
    expect(remoteControlLine(rc({ on: false, state: 'off' }), NOW)).toBe('Off');
    expect(remoteControlLine(rc({ on: false, state: 'connected' }), NOW)).toBe('Off');
  });
  it('linkState: Online while the link is (linkLive\'s window), else last seen', () => {
    const fb = { enabled: true, label: 'x' };
    expect(linkState(linkLive(entry(), fb, NOW), NOW)).toBe('Online');
    expect(linkState(linkLive(entry({ lastSeenAt: ago(3_600_000) }), fb, NOW), NOW)).toBe('Online');
    expect(linkState(linkLive(entry({ lastSeenAt: ago(120_000) }, STALE), fb, NOW), NOW)).toBe('Last seen 2m ago');
    expect(linkState(live({ online: false, lastSeenAt: ago(3 * 3_600_000) }), NOW)).toBe('Last seen 3h ago');
    expect(linkState(live({ online: false, lastSeenAt: null }), NOW)).toBe('');
  });
  it('linkState never says Online while Remote control is off', () => {
    const off = linkState(live({ online: true, enabled: false }), NOW);
    expect(off.startsWith('Remote control off · last seen ')).toBe(true);
    expect(off).not.toContain('Online');
    expect(linkState(live({ online: false, lastSeenAt: ago(120_000), enabled: false }), NOW)).toBe('Remote control off · last seen 2m ago');
    expect(linkState(live({ online: true, lastSeenAt: null, enabled: false }), NOW)).toBe('Remote control off');
  });
});
