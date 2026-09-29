(() => {
  const root = document.getElementById('wb-deployment');
  if (!root || !['electric-sky', 'indoor-sky'].includes(root.dataset.node)) return;
  root.innerHTML = `
    <h2>Deployment</h2>
    <form data-auth><label>Weather Brain status token
      <input name="token" type="password" autocomplete="off" required></label>
      <button>Connect</button><p class="wb-hint">Kept only in this page until disconnect or reload.</p></form>
    <div data-state hidden><p data-name></p><p data-location></p><p data-since></p>
      <button type="button" data-edit>Start deployment</button>
      <button type="button" data-end hidden>End</button>
      <button type="button" data-refresh>Refresh</button>
      <button type="button" data-disconnect>Disconnect</button></div>
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
  const auth = find('auth'), editor = find('editor');
  let token = '', current = null, editing = null;
  let locationRequest = 0;
  const message = text => { find('message').textContent = text; };
  async function request(action, body) {
    const response = await fetch(`/api/deployments/${root.dataset.node}${action ? '/' + action : ''}`, {
      method: action ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'X-Status-Token': token, ...(action && { 'Content-Type': 'application/json' }) },
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
    auth.hidden = true;
    find('state').hidden = false;
    find('name').textContent = current?.name || 'No active deployment';
    find('location').textContent = current?.location_label || '';
    find('since').textContent = current ? `Since ${new Date(current.started_at).toLocaleString()}` : '';
    find('edit').textContent = current ? 'Change' : 'Start deployment';
    find('end').hidden = !current;
  }
  async function refresh() { current = (await request()).deployment; render(); }
  async function run(action) {
    message('');
    root.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await action(); }
    catch (error) {
      message(error.message);
      if (error.status === 409) {
        editor.hidden = true; locationRequest++;
        try { await refresh(); } catch { /* Retain the original conflict explanation. */ }
      }
    } finally { root.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }
  auth.addEventListener('submit', event => {
    event.preventDefault(); token = auth.elements.token.value; auth.elements.token.value = '';
    run(refresh);
  });
  find('refresh').onclick = () => run(async () => { editor.hidden = true; locationRequest++; await refresh(); });
  find('disconnect').onclick = () => {
    token = ''; current = null; editing = null; locationRequest++;
    editor.reset(); editor.hidden = true; find('state').hidden = true; auth.hidden = false; message('');
  };
  find('edit').onclick = () => {
    editing = current;
    for (const name of ['name', 'location_label', 'latitude', 'longitude', 'altitude_m', 'notes']) {
      editor.elements[name].value = current?.[name] ?? '';
    }
    editor.hidden = false; editor.elements.name.focus();
  };
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
    run(async () => {
      current = (await request(editing ? 'change' : 'start', body)).deployment;
      editor.hidden = true; locationRequest++; render();
    });
  });
  find('end').onclick = () => {
    if (!current || !window.confirm(`End deployment "${current.name}"?`)) return;
    const id = current.id;
    run(async () => {
      current = (await request('end', { expected_deployment_id: id })).deployment;
      editor.hidden = true; locationRequest++; render();
    });
  };
})();
