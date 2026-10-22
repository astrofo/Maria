"use strict";

window.PortalImports = (() => {
  const template =
    "full_name,email,phone,city,skills,interests,experience,participation_format,participation_frequency,questionnaire_json\nПример Волонтёра,volunteer@example.org,,Москва,Фото,Творчество,,,,\n";
  const labels = {
    create: "Будет создан",
    skipped: "Пропущен",
    invalid: "Ошибка",
  };
  async function render({ set, api, user }) {
    if (!["manager", "admin"].includes(user?.role)) return;
    if (
      !set(
        `${header("Импорт анкет", "Перенесите новые анкеты из CSV: сначала проверка, затем подтверждение.")}<p><a href="#users" class="text-link">← К волонтёрам</a></p><section class="card"><h2>Файл с анкетами</h2><p>CSV в UTF-8, до 512 КБ и 200 строк. Можно использовать выгрузку этой системы или шаблон. Разделитель — запятая или точка с запятой.</p><p>Создаются только новые волонтёры. Существующие профили не изменяются. Импорт не подтверждает почту, согласия или завершение анкеты. Письма при импорте не отправляются.</p><button type="button" class="button secondary" data-import-template>Скачать шаблон CSV</button><form id="questionnaire-import-form"><label class="field" for="import-file">Выбрать CSV<input id="import-file" type="file" accept=".csv,text/csv"></label><label class="field" for="import-csv">Или вставьте CSV<textarea id="import-csv" name="csv" rows="8" required spellcheck="false" maxlength="524288"></textarea></label><div class="form-error" role="alert"></div><div class="actions"><button type="submit" class="button">Проверить импорт</button></div></form></section><section data-import-preview aria-live="polite"></section>`,
      )
    )
      return;
    const form = document.querySelector("#questionnaire-import-form"),
      input = form.elements.csv,
      file = document.querySelector("#import-file"),
      preview = document.querySelector("[data-import-preview]"),
      error = form.querySelector(".form-error"),
      submitButton = form.querySelector('[type="submit"]');
    let sequence = 0,
      busy = false,
      previewToken = null;
    const valid = () => set.current() && form.isConnected;
    const resetPreview = () => {
      // A preview authorizes exactly the inspected CSV, never a later edit.
      sequence++;
      previewToken = null;
      preview.replaceChildren();
      error.textContent = "";
    };
    input.addEventListener("input", resetPreview);
    file.addEventListener("change", async () => {
      resetPreview();
      const selected = file.files?.[0],
        serial = sequence;
      if (!selected) return;
      if (selected.size > 512 * 1024) {
        error.textContent =
          "Файл больше 512 КБ. Разделите его на несколько файлов.";
        return;
      }
      try {
        const text = await selected.text();
        if (valid() && serial === sequence) input.value = text;
      } catch {
        if (valid() && serial === sequence)
          error.textContent =
            "Не удалось прочитать файл. Попробуйте вставить содержимое CSV.";
      }
    });
    document
      .querySelector("[data-import-template]")
      .addEventListener("click", () => {
        const url = URL.createObjectURL(
          new Blob(["\uFEFF", template], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "volunteer-import-template.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      resetPreview();
      if (new Blob([input.value]).size > 512 * 1024) {
        error.textContent =
          "CSV больше 512 КБ. Разделите его на несколько частей.";
        return;
      }
      busy = true;
      submitButton.disabled = true;
      const serial = sequence;
      try {
        const result = await api("/questionnaire-import/preview", {
          method: "POST",
          body: JSON.stringify({ csv: input.value }),
        });
        if (!valid() || serial !== sequence) return;
        previewToken = result.preview_token;
        const summary = result.summary;
        // Imported names and error text are data; they must not become markup.
        preview.innerHTML = `<article class="card"><h2>Предпросмотр импорта</h2><p>Всего: ${number(summary.total)} · Новых: ${number(summary.create)} · Пропущено: ${number(summary.skipped)} · С ошибками: ${number(summary.invalid)}</p>${list(
          result.warnings,
        )
          .map((text) => `<p class="notice">${h(text)}</p>`)
          .join(
            "",
          )}<div class="table-wrap" role="region" aria-label="Предпросмотр анкет" tabindex="0"><table class="import-preview-table"><thead><tr><th>Строка</th><th>Имя</th><th>Почта</th><th>Результат</th><th>Пояснение</th></tr></thead><tbody>${list(
          result.rows,
        )
          .map(
            (row) =>
              `<tr><td data-label="Строка">${number(row.row)}</td><td data-label="Имя">${h(row.full_name)}</td><td data-label="Почта">${h(row.email)}</td><td data-label="Результат">${h(labels[row.status] || row.status)}</td><td data-label="Пояснение">${[...list(row.errors), ...list(row.warnings)].map(h).join("<br>") || "—"}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table></div>${result.can_apply && previewToken ? '<form id="questionnaire-import-apply"><p>Предпросмотр действует 10 минут. Созданные профили смогут войти по настоящему коду из письма; пароль и согласия не назначаются.</p><label class="check"><input type="checkbox" name="confirm" required><span>Подтверждаю создание показанных новых профилей</span></label><div class="form-error" role="alert"></div><button class="button" type="submit">Импортировать новые анкеты</button></form>' : '<p class="notice">Импорт пока недоступен. Исправьте отмеченные строки и повторите проверку.</p>'}</article>`;
        const applyForm = preview.querySelector("form");
        if (applyForm)
          applyForm.addEventListener("submit", async (applyEvent) => {
            applyEvent.preventDefault();
            if (busy || !applyForm.reportValidity() || !previewToken) return;
            busy = true;
            const token = previewToken;
            const button = applyForm.querySelector("button");
            button.disabled = true;
            input.disabled = file.disabled = submitButton.disabled = true;
            applyForm.querySelector(".form-error").textContent = "";
            try {
              const applied = await api("/questionnaire-import/apply", {
                method: "POST",
                body: JSON.stringify({ preview_token: token, confirm: true }),
              });
              if (!valid() || serial !== sequence) return;
              previewToken = null;
              preview.innerHTML = `<article class="card" role="status"><h2>Импорт завершён</h2><p>Создано: ${number(applied.created)} · Пропущено: ${number(applied.skipped)} · Всего: ${number(applied.total)}</p><a class="button" href="#users">Открыть базу волонтёров</a></article>`;
            } catch (failure) {
              if (valid() && applyForm.isConnected)
                applyForm.querySelector(".form-error").textContent =
                  failure.message;
            } finally {
              busy = false;
              if (valid())
                input.disabled = file.disabled = submitButton.disabled = false;
              if (applyForm.isConnected) button.disabled = false;
            }
          });
      } catch (failure) {
        if (valid() && serial === sequence) error.textContent = failure.message;
      } finally {
        busy = false;
        if (valid()) submitButton.disabled = false;
      }
    });
  }
  return { render };
})();
