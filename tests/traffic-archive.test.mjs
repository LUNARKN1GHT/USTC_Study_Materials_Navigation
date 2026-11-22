import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_BRANCH,
  ARCHIVE_FILE,
  ArchiveError,
  fetchTrafficViews,
  formatReport,
  mergeTrafficHistory,
  parseArchive,
  parseArgs,
  runArchive,
  serializeArchive,
} from '../scripts/archive-traffic.mjs';

const TODAY = '2026-11-22';

function views(...rows) {
  return {
    count: rows.reduce((sum, [, count]) => sum + count, 0),
    uniques: rows.reduce((sum, [, , uniques]) => sum + uniques, 0),
    views: rows.map(([date, count, uniques]) => ({ timestamp: `${date}T00:00:00Z`, count, uniques })),
  };
}

// Only loopback: every test injects a transport; no test talks to GitHub.
function fetchStub(payload, { status = 200, repo = 'TwinJades/USTC_Study_Materials_Navigation' } = {}) {
  return async (url, init) => {
    assert.equal(url, `https://api.github.com/repos/${repo}/traffic/views`);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.match(init.headers.authorization, /^Bearer /u);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
}

function runGit(args, { cwd, input, env } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Throwaway origin plus a checkout with origin configured, like what
// actions/checkout leaves behind. A real local git repo: no mock in the
// publish path.
function makeRemote() {
  const root = mkdtempSync(join(tmpdir(), 'traffic-archive-test-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  mkdirSync(work);
  runGit(['init', '-b', 'main'], { cwd: work });
  runGit(['remote', 'add', 'origin', bare], { cwd: work });
  writeFileSync(join(work, 'README.md'), 'main\n');
  runGit(['add', 'README.md'], { cwd: work });
  runGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'init'], { cwd: work });
  runGit(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
  return {
    work,
    git: (args, options) => runGit(args, { cwd: work, ...options }),
    ref: (name) => runGit(['rev-parse', name], { cwd: bare }).trim(),
    refExists: (name) => execFileSync('git', ['rev-parse', '--verify', name], { cwd: bare, encoding: 'utf8' }).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('merge: completed UTC days are archived, revisions replace, zeros stay zero', () => {
  const existing = parseArchive(serializeArchive({ schema_version: 1, days: { '2026-11-19': { count: 40, uniques: 9 } } }));
  const merged = mergeTrafficHistory(existing, views(
    ['2026-11-19', 41, 9],
    ['2026-11-20', 0, 0],
    ['2026-11-21', 7, 3],
    ['2026-11-22', 5, 2],
  ), { todayUtc: TODAY });

  assert.deepEqual(merged.archive.days, {
    '2026-11-19': { count: 41, uniques: 9 },
    '2026-11-20': { count: 0, uniques: 0 },
    '2026-11-21': { count: 7, uniques: 3 },
  });
  assert.equal(merged.partial, 1, 'the current UTC day is skipped, not zero-filled');
  assert.deepEqual([merged.added, merged.updated, merged.unchanged], [2, 1, 0]);
});

test('serialize: unchanged data re-merges to identical bytes', () => {
  const payload = views(['2026-11-20', 3, 1], ['2026-11-19', 2, 1]);
  const first = serializeArchive(mergeTrafficHistory(parseArchive(null), payload, { todayUtc: TODAY }).archive);
  assert.equal(first, serializeArchive(mergeTrafficHistory(parseArchive(first), payload, { todayUtc: TODAY }).archive));
  assert.doesNotMatch(first, /collected|updated_at|generated/u);
});

test('archive file: unknown schema, extra fields and malformed counts are refused', () => {
  assert.throws(() => parseArchive('{'), ArchiveError);
  assert.throws(() => parseArchive('{"schema_version":2,"days":{}}'), /格式/u);
  assert.throws(
    () => parseArchive('{"schema_version":1,"days":{"2026-11-19":{"count":1,"uniques":1,"paths":{}}}}'),
    /count\/uniques/u,
  );
  assert.throws(
    () => parseArchive('{"schema_version":1,"days":{"2026-11-19":{"count":-1,"uniques":1}}}'),
    /非负整数/u,
  );
  assert.deepEqual(parseArchive(''), { schema_version: 1, days: {} });
});

test('payload: missing views, duplicate dates and non-integer counts fail, never guess', () => {
  assert.throws(() => mergeTrafficHistory(parseArchive(null), {}, { todayUtc: TODAY }), /views/u);
  assert.throws(
    () => mergeTrafficHistory(parseArchive(null), { views: [{ timestamp: '2026-11-20T00:00:00Z', count: 1.5, uniques: 1 }] }, { todayUtc: TODAY }),
    /数据无效/u,
  );
  assert.throws(
    () => mergeTrafficHistory(parseArchive(null), views(['2026-11-20', 1, 1], ['2026-11-20', 2, 1]), { todayUtc: TODAY }),
    /重复日期/u,
  );
});

test('token: missing or denied Traffic access fails loudly, no zero is written', async () => {
  const denied = await runArchive({
    repo: 'TwinJades/USTC_Study_Materials_Navigation',
    token: 'test-token',
    fetchImpl: fetchStub({ message: 'Resource not accessible by integration' }, { status: 403 }),
  }).then(() => null, (error) => error);
  assert.ok(denied instanceof ArchiveError);
  assert.equal(denied.code, 'traffic_unavailable');
  assert.match(denied.message, /TRAFFIC_TOKEN/u);

  const noToken = await runArchive({ repo: 'TwinJades/USTC_Study_Materials_Navigation', token: null })
    .then(() => null, (error) => error);
  assert.equal(noToken.code, 'missing_token');
});

test('publish: first run creates the branch, later runs fast-forward without a no-op commit', async () => {
  const remote = makeRemote();
  try {
    const base = { mode: 'publish', repo: 'TwinJades/USTC_Study_Materials_Navigation', token: 'test-token', cwd: remote.work, git: remote.git };
    const mainBefore = remote.ref('refs/heads/main');

    const first = await runArchive({
      ...base,
      now: () => new Date(`${TODAY}T05:00:00Z`),
      fetchImpl: fetchStub(views(['2026-11-20', 4, 2], ['2026-11-21', 9, 4], ['2026-11-22', 1, 1])),
    });
    assert.equal(first.pushed, true);
    assert.equal(remote.ref(`refs/heads/${ARCHIVE_BRANCH}`), first.commit);
    assert.deepEqual(JSON.parse(remote.git(['show', `${first.commit}:${ARCHIVE_FILE}`])).days, {
      '2026-11-20': { count: 4, uniques: 2 },
      '2026-11-21': { count: 9, uniques: 4 },
    });

    const second = await runArchive({
      ...base,
      now: () => new Date(`${TODAY}T05:00:00Z`),
      fetchImpl: fetchStub(views(['2026-11-21', 9, 4], ['2026-11-22', 1, 1])),
    });
    assert.equal(second.pushed, false, 'identical content is not re-committed');
    assert.equal(second.reason, 'unchanged');

    const third = await runArchive({
      ...base,
      now: () => new Date('2026-11-23T05:00:00Z'),
      fetchImpl: fetchStub(views(['2026-11-22', 6, 3], ['2026-11-23', 1, 1])),
    });
    assert.equal(third.pushed, true);
    assert.deepEqual(
      remote.git(['rev-list', '--parents', '-n', '1', third.commit]).trim().split(' '),
      [third.commit, first.commit],
      'the archive commit builds on the previous one',
    );
    assert.deepEqual(JSON.parse(remote.git(['show', `${third.commit}:${ARCHIVE_FILE}`])).days, {
      '2026-11-20': { count: 4, uniques: 2 },
      '2026-11-21': { count: 9, uniques: 4 },
      '2026-11-22': { count: 6, uniques: 3 },
    });
    assert.equal(remote.ref('refs/heads/main'), mainBefore, 'the default branch is untouched');
    assert.equal(remote.git(['status', '--porcelain']).trim(), '', 'the checkout working tree is never modified');
  } finally {
    remote.cleanup();
  }
});

test('publish: a rejected push fails the run and is never forced', async () => {
  const remote = makeRemote();
  try {
    const base = { mode: 'publish', repo: 'TwinJades/USTC_Study_Materials_Navigation', token: 'test-token', cwd: remote.work };
    await runArchive({ ...base, git: remote.git, fetchImpl: fetchStub(views(['2026-11-20', 4, 2])) });
    const archived = remote.ref(`refs/heads/${ARCHIVE_BRANCH}`);

    // Another writer lands on the branch between our fetch and our push.
    const racingGit = (args, options) => {
      if (args[0] === 'push') remote.git(['push', '--force', 'origin', 'refs/heads/main:refs/heads/' + ARCHIVE_BRANCH], options);
      return remote.git(args, options);
    };
    const error = await runArchive({
      ...base,
      git: racingGit,
      now: () => new Date('2026-11-23T05:00:00Z'),
      fetchImpl: fetchStub(views(['2026-11-22', 6, 3])),
    }).then(() => null, (caught) => caught);

    assert.ok(error instanceof ArchiveError, 'a lost race is reported, not swallowed');
    assert.equal(error.code, 'push_rejected');
    assert.match(error.message, /未使用强制推送/u);
    assert.equal(remote.ref(`refs/heads/${ARCHIVE_BRANCH}`), remote.ref('refs/heads/main'));
    assert.notEqual(remote.ref(`refs/heads/${ARCHIVE_BRANCH}`), archived);
  } finally {
    remote.cleanup();
  }
});

test('publish: the token never reaches the commit, the file, the config or the report', async () => {
  const remote = makeRemote();
  const token = 'ghp_supersecretvalue1234567890';
  try {
    const report = await runArchive({
      mode: 'publish',
      repo: 'TwinJades/USTC_Study_Materials_Navigation',
      token,
      cwd: remote.work,
      git: remote.git,
      now: () => new Date(`${TODAY}T05:00:00Z`),
      fetchImpl: fetchStub(views(['2026-11-21', 1, 1])),
    });
    assert.doesNotMatch(JSON.stringify(report) + formatReport(report), /ghp_/u);
    assert.doesNotMatch(remote.git(['show', `${report.commit}:${ARCHIVE_FILE}`]), /ghp_/u);
    assert.doesNotMatch(remote.git(['log', '-1', '--format=%B', report.commit]), /ghp_/u);
    assert.doesNotMatch(remote.git(['config', '--get-regexp', '.*']), /ghp_/u);
  } finally {
    remote.cleanup();
  }
});

test('publish: an existing branch without a usable archive file fails instead of reinitializing', async () => {
  const remote = makeRemote();
  try {
    // A branch named like the archive, but carrying no traffic-history.json.
    remote.git(['push', 'origin', 'refs/heads/main:refs/heads/' + ARCHIVE_BRANCH]);
    const before = remote.ref(`refs/heads/${ARCHIVE_BRANCH}`);
    const base = { mode: 'publish', repo: 'TwinJades/USTC_Study_Materials_Navigation', token: 'test-token', cwd: remote.work, git: remote.git };

    const error = await runArchive({
      ...base,
      now: () => new Date(`${TODAY}T05:00:00Z`),
      fetchImpl: fetchStub(views(['2026-11-20', 4, 2])),
    }).then(() => null, (caught) => caught);
    assert.ok(error instanceof ArchiveError);
    assert.equal(error.code, 'invalid_archive');
    assert.match(error.message, /已存在但缺少可用的/u);
    assert.equal(remote.ref(`refs/heads/${ARCHIVE_BRANCH}`), before, 'the broken branch is left untouched');
  } finally {
    remote.cleanup();
  }
});

test('cli: only --publish is accepted, everything else is rejected', () => {
  assert.equal(parseArgs([]).mode, 'dry-run');
  assert.equal(parseArgs(['--publish']).mode, 'publish');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--repo', 'a/b']), ArchiveError);
});

test('fetch: the API URL is fixed and the token only goes there', async () => {
  await fetchTrafficViews({ repo: 'o/r', token: 't', fetchImpl: fetchStub(views(['2026-11-20', 1, 1]), { repo: 'o/r' }) });
  await assert.rejects(
    () => fetchTrafficViews({ repo: 'o', token: 't', fetchImpl: fetchStub(views()) }),
    /owner\/name/u,
  );
});
