const $ = id => document.getElementById(id);
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const state = {account: null, cursor: null, busy: false, authenticated: false, authEpoch: 0, pending: null, uncertain: null};
const date = value => value === null ? 'Until manually reinstated' : new Date(value).toLocaleString();
const element = (tag, text) => {const node = document.createElement(tag); node.textContent = text; return node;};
function message(text, error = false) {$('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('error', error);}
function lock() {
  state.authEpoch++; state.authenticated = false; state.account = null; state.pending = null; state.uncertain = null;
  $('admin-workspace').hidden = true; $('admin-login').hidden = false; $('sign-out').hidden = true;
  $('account-details').hidden = true; $('history').replaceChildren(); $('suspension-list').replaceChildren();
  $('confirm-dialog').close(); $('google-signin').hidden = false; $('login-status').textContent = 'Sign in with your authorized Google account to continue.';
}
window.addEventListener('storage', event => {if (event.key === 'wonderlines.logout.v1') lock();});
async function api(path, options = {}) {
  const epoch = state.authEpoch;
  const response = await fetch('/api/admin' + path, {credentials: 'same-origin', cache: 'no-store', ...options,
    headers: {...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers}});
  if (epoch !== state.authEpoch) throw new Error('The admin session ended. Sign in again.');
  if (response.status === 401) lock();
  const data = await response.json();
  if (!response.ok) {const error = new Error(data.error?.message ?? 'The request could not be completed.'); error.status = response.status; throw error;}
  return data;
}
function controls() {
  for (const button of document.querySelectorAll('main button')) button.disabled = state.busy;
  $('action-fields').disabled = state.busy || !!state.uncertain || !state.account;
  $('sign-out').disabled = state.busy;
}
async function run(action) {
  if (state.busy) return; state.busy = true; controls();
  try {await action();} catch (error) {message(error.message, true);} finally {state.busy = false; controls();}
}
async function list(append = false) {
  const data = await api('/suspensions' + (append && state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : ''));
  if (!state.authenticated) return;
  if (!append) $('suspension-list').replaceChildren();
  for (const record of data.accounts) {
    const li = element('li', ''), button = element('button', record.accountId); button.type = 'button'; button.className = 'text-button';
    button.addEventListener('click', () => run(() => load(record.accountId))); li.append(button,
      element('small', (record.suspension.source === 'automatic' ? 'Automatic' : 'Operator') + ' · ' + date(record.suspension.until)));
    $('suspension-list').append(li);
  }
  state.cursor = data.nextCursor; $('more').hidden = !state.cursor;
  $('list-status').textContent = $('suspension-list').children.length ? '' : state.cursor ? 'No active suspensions on this page. Load more to continue.' : 'No active suspensions.';
}
function render(account) {
  state.account = account; $('account-details').hidden = false; $('selected-id').textContent = account.accountId;
  const suspension = account.suspension;
  $('account-status').textContent = suspension ? 'Generation suspended · ' + date(suspension.until) : 'Generation allowed';
  $('strike-count').textContent = `${account.rejectionCount} of ${account.threshold} qualifying rejections in the last 24 hours.`;
  $('suspension-reason').textContent = suspension ? suspension.reason : '';
  $('action').value = suspension ? 'reinstate' : 'suspend'; duration();
  $('history').replaceChildren();
  for (const entry of [...account.history].reverse()) {
    const li = element('li', '');
    li.append(element('strong', entry.action === 'automatic_suspend' ? 'Automatic suspension' : entry.action === 'suspend' ? 'Operator suspension' : 'Reinstated / strikes cleared'),
      element('p', entry.reason), element('small', date(entry.at) + ' · ' + (entry.actor?.email ?? 'Automatic policy')));
    if (entry.action !== 'reinstate') li.append(element('p', 'Duration: ' + date(entry.until)));
    $('history').append(li);
  }
  if (!account.history.length) $('history').append(element('li', 'No suspension changes recorded.'));
}
async function load(id) {
  id = id.trim().toLowerCase();
  if (state.uncertain && id !== state.uncertain.accountId) throw new Error('Refresh account ' + state.uncertain.accountId + ' to check the pending change first.');
  if (!uuid(id)) throw new Error('Enter a valid account UUID.');
  const account = await api('/accounts/' + id); if (!state.authenticated) return;
  render(account); $('account-id').value = id; message('');
  if (state.uncertain) {
    const applied = account.history.some(entry => entry.id === state.uncertain.requestId);
    message(applied ? 'The change was saved.' : 'The requested change is not recorded. Review the current account before trying again.', !applied);
    state.uncertain = null;
  }
}
function duration() {$('duration-field').hidden = $('action').value === 'reinstate';}
$('action').addEventListener('change', duration);
$('lookup-form').addEventListener('submit', event => {event.preventDefault(); run(() => load($('account-id').value));});
$('refresh-list').addEventListener('click', () => run(() => list()));
$('more').addEventListener('click', () => run(() => list(true)));
$('refresh-account').addEventListener('click', () => run(() => load(state.account.accountId)));
$('action-form').addEventListener('submit', event => {
  event.preventDefault(); if (state.busy || state.uncertain || !state.account) return;
  const reason = $('reason').value.trim(); if (!reason) {message('Enter a reason for the change.', true); return;}
  const action = $('action').value, durationHours = $('duration').value === 'indefinite' ? null : Number($('duration').value);
  state.pending = {accountId: state.account.accountId, action, reason, durationHours: action === 'suspend' ? durationHours : null,
    requestId: crypto.randomUUID(), expectedVersion: state.account.version};
  $('confirm-copy').textContent = action === 'reinstate' ? `Reinstate ${state.pending.accountId} and clear its current strikes?`
    : `Suspend generation for ${state.pending.accountId} ${durationHours === null ? 'until manually reinstated' : 'for ' + durationHours + ' hours'}?`;
  $('confirm-reason').textContent = 'Reason: ' + reason; $('confirm-dialog').showModal();
});
$('cancel-change').addEventListener('click', () => {state.pending = null; $('confirm-dialog').close();});
$('confirm-change').addEventListener('click', () => {
  if (!state.pending || state.busy) return;
  const pending = state.pending; state.pending = null; $('confirm-dialog').close();
  run(async () => {
    const {accountId, ...input} = pending;
    try {
      const account = await api('/accounts/' + accountId + '/suspension', {method: 'POST', body: JSON.stringify(input)});
      if (!state.authenticated) return; render(account); $('reason').value = ''; message('The account change was saved.');
    } catch (error) {
      if (!state.authenticated) throw error;
      // No automatic resubmission after an ambiguous write. Read history by the
      // original operation ID before allowing another mutation.
      if (!error.status || error.status >= 500) {state.uncertain = pending; message('The result is uncertain. Refresh this account to check whether the change was saved.', true);}
      else {await load(accountId); message(error.message, true);}
      return;
    }
    try {await list();} catch {message('The account change was saved. Refresh the suspension list to update it.');}
  });
});
$('sign-out').addEventListener('click', () => run(async () => {
  await api('/logout', {method: 'POST', body: '{}'}); lock();
  try {localStorage.setItem('wonderlines.logout.v1', crypto.randomUUID());} catch {}
}));
run(async () => {
  const session = await api('/session'); $('google-signin').hidden = !session.configured;
  if (!session.authenticated) {$('login-status').textContent = session.configured ? 'Use your authorized Google account.' : 'Admin sign-in is not configured.'; return;}
  state.authenticated = true; $('admin-login').hidden = true; $('admin-workspace').hidden = false; $('sign-out').hidden = false;
  await list();
});
