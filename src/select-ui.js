const controls = new WeakMap();
let openControl = null;

function selectedLabel(select) {
  return select.selectedOptions[0]?.textContent?.trim() || "请选择";
}

function closeMenu(focusButton = false) {
  if (!openControl) return;
  const { button, menu } = openControl;
  menu.remove();
  button.classList.remove("is-open");
  button.setAttribute("aria-expanded", "false");
  if (focusButton) button.focus();
  openControl = null;
}

function positionMenu(control) {
  const { button, menu } = control;
  const rect = button.getBoundingClientRect();
  const margin = 6;
  const width = Math.max(rect.width, 150);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - margin)}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  const menuHeight = Math.min(menu.scrollHeight, 300);
  const below = window.innerHeight - rect.bottom - margin;
  const above = rect.top - margin;
  if (menuHeight > below && above > below) {
    menu.style.top = `${Math.max(margin, rect.top - menuHeight - 4)}px`;
  }
}

function focusOption(menu, direction = 0) {
  const options = [...menu.querySelectorAll(".ui-select-option:not(:disabled)")];
  if (!options.length) return;
  const current = document.activeElement;
  let index = options.indexOf(current);
  if (index < 0) index = Math.max(0, options.findIndex((item) => item.classList.contains("is-selected")));
  else index = (index + direction + options.length) % options.length;
  options[index].focus();
}

function choose(control, value) {
  const { select } = control;
  if (select.value === value) {
    closeMenu(true);
    return;
  }
  select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  closeMenu(true);
}

function buildMenu(control) {
  const { select, button } = control;
  const menu = document.createElement("div");
  menu.className = "ui-select-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", button.getAttribute("aria-label") || "选项");

  [...select.options].forEach((option) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ui-select-option";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.selected));
    item.dataset.value = option.value;
    item.disabled = option.disabled;
    item.textContent = option.textContent;
    item.classList.toggle("is-selected", option.selected);
    item.addEventListener("click", () => choose(control, option.value));
    menu.append(item);
  });

  menu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(menu, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const options = [...menu.querySelectorAll(".ui-select-option:not(:disabled)")];
      options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      closeMenu(event.key === "Escape");
    }
  });
  return menu;
}

function openMenu(control) {
  if (control.select.disabled) return;
  if (openControl === control) {
    closeMenu(true);
    return;
  }
  closeMenu();
  control.menu = buildMenu(control);
  document.body.append(control.menu);
  control.button.classList.add("is-open");
  control.button.setAttribute("aria-expanded", "true");
  openControl = control;
  positionMenu(control);
  requestAnimationFrame(() => {
    const selected = control.menu.querySelector(".is-selected");
    if (selected) control.menu.scrollTop = Math.max(0, selected.offsetTop - control.menu.clientHeight / 2);
  });
}

function sync(select) {
  const control = controls.get(select);
  if (!control) return;
  control.button.querySelector(".ui-select-value").textContent = selectedLabel(select);
  control.button.disabled = select.disabled;
  control.wrapper.classList.toggle("is-disabled", select.disabled);
  if (openControl === control) {
    closeMenu();
    openMenu(control);
  }
}

function watchValue(select, property) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
  if (!descriptor?.get || !descriptor?.set) return;
  Object.defineProperty(select, property, {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) {
      descriptor.set.call(this, value);
      queueMicrotask(() => sync(this));
    },
  });
}

function enhance(select) {
  if (controls.has(select) || select.classList.contains("native-select")) return;
  const wrapper = document.createElement("span");
  wrapper.className = "ui-select";
  select.before(wrapper);
  wrapper.append(select);
  select.classList.add("ui-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-select-button";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const label = select.closest("label")?.querySelector(":scope > span")?.textContent?.trim();
  button.setAttribute("aria-label", label || select.getAttribute("aria-label") || "选择选项");
  button.innerHTML = '<span class="ui-select-value"></span><span class="ui-select-chevron" aria-hidden="true"></span>';
  wrapper.append(button);

  const control = { select, wrapper, button, menu: null };
  controls.set(select, control);
  button.addEventListener("click", () => openMenu(control));
  button.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openMenu(control);
      if (event.key.startsWith("Arrow")) requestAnimationFrame(() => focusOption(control.menu));
    }
  });
  select.addEventListener("change", () => sync(select));
  watchValue(select, "value");
  watchValue(select, "selectedIndex");

  sync(select);
}

function enhanceTree(root) {
  if (root instanceof HTMLSelectElement) enhance(root);
  root.querySelectorAll?.("select").forEach(enhance);
}

export function initSelectUi() {
  enhanceTree(document);
  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) enhanceTree(node);
      });
      if (record.type === "attributes" && record.target instanceof HTMLSelectElement) sync(record.target);
    });
    if (openControl && !openControl.select.isConnected) closeMenu();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

  document.addEventListener("pointerdown", (event) => {
    if (!openControl) return;
    if (!openControl.wrapper.contains(event.target) && !openControl.menu.contains(event.target)) closeMenu();
  });
  window.addEventListener("resize", () => closeMenu());
  document.addEventListener("scroll", (event) => {
    if (event.target !== openControl?.menu) closeMenu();
  }, true);
}
