(() => {
  const root = document.getElementById('wb-deployment');
  if (!root || !['electric-sky', 'indoor-sky'].includes(root.dataset.node)) return;
  root.innerHTML = `
    <h2>Deployment</h2>
    <div data-state><p data-name>Loading deployment...</p><p data-location></p><p data-since></p>
      <button type="button" data-edit>Start deployment</button>
      <button type="button" data-end hidden>End</button>
      <button type="button" data-refresh>Refresh</button></div>
    <button type="button" data-correct>Correct deployment history</button>
    <form data-correction hidden>
      <h3>Correct deployment history</h3>
      <p>For a move recorded at the wrong time. Use Change deployment for a physical move happening now.</p>
      <pre data-history></pre>
      <label>Transition<select name="transition" required></select></label>
      <label>Actual move timestamp (UTC or explicit offset)
        <input name="boundary" required placeholder="2026-10-23T21:00:00Z"></label>
      <p data-timezone></p>
      <label>Correction reason<input name="reason" required maxlength="1000"></label>
      <button type="submit">Preview correction</button>
      <button type="button" data-correction-cancel>Cancel</button>
      <pre data-preview></pre>
      <button type="button" data-apply-correction hidden>Apply correction</button>
      <button type="button" data-rebuild-status>Refresh snapshot rebuild status</button>
      <pre data-rebuild></pre>
    </form>
    <form data-editor hidden>
      <label>Deployment name<input name="name" required maxlength="255"></label>
      <label>Location label<input name="location_label" maxlength="500"></label>
      <div class="wb-grid">
        <label>Latitude (optional)<input name="latitude" type="number" step="any" min="-90" max="90"></label>
        <label>Longitude (optional)<input name="longitude" type="number" step="any" min="-180" max="180"></label>
      </div>
      <label>Altitude in metres (optional)<input name="altitude_m" type="number" step="any"></label>
      <button type="button" data-locate>Use current location</button>
      <p class="wb-hint">Uses the browser's location once. Edit or clear coordinates to match the sensor.</p>
      <label>Notes (optional)<textarea name="notes" rows="2" maxlength="10000"></textarea></label>
      <button type="submit">Save deployment</button><button type="button" data-cancel>Cancel</button>
    </form>
    <p data-message class="wb-message" role="status" aria-live="polite"></p>`;
  const find = name => root.querySelector(`[data-${name}]`);
  const dialog = document.getElementById('es-admin-dialog');
  const adminButton = document.getElementById('es-admin-toggle');
  const auth = dialog.querySelector('[data-auth]'), editor = find('editor');
  let isAdmin = false;
  let current = null, editing = null, pendingAction = null;
  let locationRequest = 0;
  const message = text => {
    (dialog.open ? dialog.querySelector('[data-auth-message]') : find('message')).textContent = text;
  };
  async function request(action, body, method = action ? 'POST' : 'GET') {
    const response = await fetch(`/api/deployments/${root.dataset.node}${action ? '/' + action : ''}`, {
      method, cache: 'no-store',
      headers: { ...(action && { 'Content-Type': 'application/json', 'X-Electric-Sea-Admin': '1' }) },
      ...(method === 'POST' && { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(typeof data.detail === 'string' ? data.detail : 'Check the deployment fields and try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function render() {
    find('state').hidden = false;
    find('name').textContent = current?.name || 'No active deployment';
    find('location').textContent = current?.location_label || '';
    find('since').textContent = current ? `Since ${new Date(current.started_at).toLocaleString()}` : '';
    find('edit').textContent = current ? 'Change deployment' : 'Start deployment';
    find('end').hidden = !current;
  }
  async function refresh() { current = (await request()).deployment; render(); }
  async function run(action) {
    message('');
    root.querySelectorAll('button,input,select,textarea').forEach(button => { button.disabled = true; });
    adminButton.disabled = true;
    auth.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await action(); }
    catch (error) {
      message(error.message);
      if (error.status === 401) promptAdmin(action);
      if (error.status === 409) {
        clearPreview();
        editor.hidden = true; locationRequest++;
        try { await refresh(); } catch { /* Retain the original conflict explanation. */ }
      }
    } finally {
      root.querySelectorAll('button,input,select,textarea').forEach(button => { button.disabled = false; });
      adminButton.disabled = false;
      auth.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
  async function adminRequest(path, body) {
    const response = await fetch('/api/admin/' + path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Electric-Sea-Admin': '1' },
      ...(body !== undefined && { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Admin request failed');
    isAdmin = data.authenticated;
    adminButton.textContent = isAdmin ? 'Lock admin' : 'Unlock admin';
    return data;
  }
  function promptAdmin(action) {
    pendingAction = action;
    dialog.querySelector('[data-auth-message]').textContent = '';
    if (!dialog.open) dialog.showModal();
    auth.elements.password.focus();
  }
  function authorized(action) {
    return run(async () => {
      if ((await adminRequest('status')).authenticated) await action();
      else promptAdmin(action);
    });
  }
  auth.addEventListener('submit', event => {
    event.preventDefault();
    const login = adminRequest('login', { password: auth.elements.password.value });
    auth.elements.password.value = '';
    run(async () => {
      await login;
      const action = pendingAction; pendingAction = null;
      dialog.close();
      if (action) await action();
    });
  });
  dialog.querySelector('[data-auth-cancel]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { pendingAction = null; auth.elements.password.value = ''; });
  find('refresh').onclick = () => run(async () => { editor.hidden = true; locationRequest++; await refresh(); });
  adminButton.onclick = () => {
    if (!isAdmin) { promptAdmin(null); return; }
    return run(async () => {
    await adminRequest('logout', {}); editing = null; pendingAction = null; locationRequest++;
      clearPreview(); correction.hidden = true;
      editor.reset(); editor.hidden = true; dialog.close(); auth.elements.password.value = '';
    });
  };
  find('edit').onclick = () => authorized(() => {
    editing = current;
    for (const name of ['name', 'location_label', 'latitude', 'longitude', 'altitude_m', 'notes']) {
      editor.elements[name].value = current?.[name] ?? '';
    }
    editor.hidden = false; editor.elements.name.focus();
  });
  find('cancel').onclick = () => { editor.hidden = true; locationRequest++; message(''); };
  find('locate').onclick = () => {
    if (!navigator.geolocation) return message('Browser location is unavailable. Enter coordinates manually.');
    const requestId = ++locationRequest;
    navigator.geolocation.getCurrentPosition(position => {
      if (requestId !== locationRequest || editor.hidden) return;
      editor.elements.latitude.value = position.coords.latitude;
      editor.elements.longitude.value = position.coords.longitude;
      if (position.coords.altitude != null) editor.elements.altitude_m.value = position.coords.altitude;
      message('Coordinates filled from this browser. Review them before saving.');
    }, () => {
      if (requestId === locationRequest) message('Location was unavailable or denied. You can enter or omit coordinates.');
    }, { timeout: 10000, maximumAge: 0 });
  };
  editor.addEventListener('submit', event => {
    event.preventDefault();
    const body = { name: editor.elements.name.value, metadata: editing?.metadata || {} };
    for (const key of ['location_label', 'notes']) body[key] = editor.elements[key].value || null;
    for (const key of ['latitude', 'longitude', 'altitude_m']) {
      body[key] = editor.elements[key].value === '' ? null : Number(editor.elements[key].value);
    }
    if (editing) body.expected_deployment_id = editing.id;
    authorized(async () => {
      current = (await request(editing ? 'change' : 'start', body)).deployment;
      editor.hidden = true; locationRequest++; render();
    });
  });
  find('end').onclick = () => authorized(async () => {
    if (!current || !window.confirm(`End deployment "${current.name}"?`)) return;
    const id = current.id;
    current = (await request('end', { expected_deployment_id: id })).deployment;
    editor.hidden = true; locationRequest++; render();
  });
  const correction = find('correction');
  let transitions = [], reviewed = null;
  const clearPreview = () => { reviewed = null; find('apply-correction').hidden = true; find('preview').textContent = ''; };
  const interval = d => `${d.name} | ${d.location_label || 'No location'} | ${d.started_at} to ${d.ended_at || 'open'} | ${d.id}`;
  async function rebuildStatus() {
    const data = await request('correction-status', undefined, 'GET');
    find('rebuild').textContent = data.corrections.length ? data.corrections.map(c =>
      `${c.corrected_at}: ${c.rebuild_status.toUpperCase()}\nRebuilt ${c.rebuilt_windows} documents; next ${c.rebuild_next}; end ${c.rebuild_end}\n${c.rebuild_error || (c.rebuild_status === 'complete' ? 'Archive and vectors rebuilt.' : 'Snapshots may still contain old context. Scheduler will continue automatically.')}`
    ).join('\n\n') : 'No historical corrections recorded.';
  }
  find('correct').onclick = () => authorized(async () => {
    clearPreview();
    const rows = (await request('history', undefined, 'GET')).deployments;
    find('history').textContent = rows.map(interval).join('\n\n');
    transitions = rows.slice(1).map((next, i) => ({ old: rows[i], next }))
      .filter(t => t.old.ended_at === t.next.started_at);
    correction.elements.transition.replaceChildren();
    transitions.forEach((t, i) => {
      const option = document.createElement('option'); option.value = String(i);
      option.textContent = `${t.old.name} → ${t.next.name} (${t.next.started_at})`;
      correction.elements.transition.append(option);
    });
    correction.hidden = false; editor.hidden = true;
    message(transitions.length ? 'Choose a transition, enter its actual timestamp and a reason, then preview.' : 'No adjacent transitions available.');
    await rebuildStatus();
  });
  correction.addEventListener('input', () => {
    clearPreview();
    const value = correction.elements.boundary.value;
    const valid = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
    find('timezone').textContent = valid ? `Resulting UTC timestamp: ${new Date(value).toISOString()}` : 'Include Z for UTC or an explicit offset such as -07:00. Local times without an offset are not accepted.';
  });
  correction.addEventListener('submit', event => {
    event.preventDefault(); clearPreview();
    authorized(async () => {
      const t = transitions[Number(correction.elements.transition.value)];
      const boundary = correction.elements.boundary.value;
      if (!t || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(boundary) || !Number.isFinite(Date.parse(boundary))) throw new Error('Select a transition and enter a timestamp with a timezone.');
      const body = { old_deployment_id: t.old.id, new_deployment_id: t.next.id,
        boundary: new Date(boundary).toISOString(), reason: correction.elements.reason.value.trim() };
      if (!body.reason) throw new Error('Enter a correction reason.');
      const preview = await request('correction-preview', body);
      reviewed = { ...body, preview_token: preview.preview_token };
      find('preview').textContent = `CURRENT\n${preview.current.map(interval).join('\n')}\n\nPROPOSED\n${preview.proposed.map(interval).join('\n')}\n\nAffected interval: [${preview.interval.start}, ${preview.interval.end})\nOnly deployment ${preview.source_deployment_id} → ${preview.target_deployment_id}\n${preview.counts.map(c => `${c.signal_id}: ${c.count} measurements`).join('\n') || '0 measurements'}\n\nSnapshot rebuild: ${preview.snapshots.start} to ${preview.snapshots.end} (exclusive), ${preview.snapshots.hours} hourly windows\n${preview.snapshots.scope}\nRebuild runs after correction; pending or failed snapshots may still have old context.`;
      find('apply-correction').hidden = false;
    });
  });
  find('apply-correction').onclick = () => authorized(async () => {
    if (!reviewed) return;
    const result = await request('correction-apply', reviewed);
    clearPreview();
    message(`Historical boundary and measurements corrected. Snapshot rebuild: ${result.rebuild_status}.`);
    await refresh(); await rebuildStatus();
  });
  find('correction-cancel').onclick = () => { clearPreview(); correction.hidden = true; };
  find('rebuild-status').onclick = () => run(rebuildStatus);
  const restart = document.getElementById('restartDevice');
  if (restart) restart.onclick = () => authorized(async () => {
    if (!window.confirm(`Restart ${root.dataset.node}? Data and audio will pause briefly.`)) return;
    const response = await fetch(`/${root.dataset.node}/restart`, {
      method: 'POST', headers: { 'X-Electric-Sea-Admin': '1' }, cache: 'no-store'
    });
    if (!response.ok) {
      const error = new Error('Device restart failed'); error.status = response.status; throw error;
    }
    restart.disabled = true; restart.textContent = 'restarting...';
    setTimeout(() => location.reload(), 8000);
  });
  run(refresh);
  adminRequest('status').catch(() => {});
})();
