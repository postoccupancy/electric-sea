(() => {
  const root = document.getElementById('wb-deployment');
  if (!root || !['electric-sky', 'indoor-sky'].includes(root.dataset.node)) return;
  root.innerHTML = `
    <h2>Deployment</h2>
    <div data-state><p data-name>Loading deployment...</p><p data-location></p><p data-since></p>
      <button type="button" data-edit>Start deployment</button>
      <button type="button" data-end hidden>End</button>
      <button type="button" data-refresh>Refresh</button></div>
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
  async function request(action, body) {
    const response = await fetch(`/api/deployments/${root.dataset.node}${action ? '/' + action : ''}`, {
      method: action ? 'POST' : 'GET', cache: 'no-store',
      headers: { ...(action && { 'Content-Type': 'application/json', 'X-Electric-Sea-Admin': '1' }) },
      ...(action && { body: JSON.stringify(body) })
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
    find('edit').textContent = current ? 'Edit deployment' : 'Start deployment';
    find('end').hidden = !current;
  }
  async function refresh() { current = (await request()).deployment; render(); }
  async function run(action) {
    message('');
    root.querySelectorAll('button').forEach(button => { button.disabled = true; });
    adminButton.disabled = true;
    auth.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await action(); }
    catch (error) {
      message(error.message);
      if (error.status === 401) promptAdmin(action);
      if (error.status === 409) {
        editor.hidden = true; locationRequest++;
        try { await refresh(); } catch { /* Retain the original conflict explanation. */ }
      }
    } finally {
      root.querySelectorAll('button').forEach(button => { button.disabled = false; });
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
