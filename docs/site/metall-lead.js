/**
 * Сбор меток визита и отправка заявки в CRM METALL ASIA.
 *
 * Ставится на сайт заказчика одним файлом. Делает три вещи:
 *   1. запоминает первое касание посетителя на 90 дней;
 *   2. обновляет последнее касание на каждом визите;
 *   3. отправляет форму в CRM вместе с обоими касаниями.
 *
 * Почему два касания: человек находит сайт в поиске, уходит думать, через
 * неделю возвращается прямым заходом и оставляет заявку. По последнему
 * касанию работа поиска не видна вовсе, по первому — видна целиком, но ей
 * приписывается и то, что сделала реклама. В CRM хранятся оба.
 *
 * Данные лежат в localStorage самого сайта и никуда, кроме CRM, не уходят.
 */
(function () {
  'use strict';

  var ENDPOINT = window.METALL_LEAD_ENDPOINT || 'https://metall-asia.cloudplus.uz/api/v1/public/leads';
  var KEY = window.METALL_LEAD_KEY || '';
  var STORE_FIRST = 'ma_first_touch';
  var STORE_LAST = 'ma_last_touch';
  var STORE_VID = 'ma_visitor';
  var DAYS = 90;

  function read(name) {
    try {
      var raw = localStorage.getItem(name);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (v && v.at && Date.now() - new Date(v.at).getTime() > DAYS * 86400000) return null;
      return v;
    } catch (e) {
      return null;
    }
  }

  function write(name, value) {
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch (e) {
      /* приватный режим: метки просто не сохранятся, форма работать не перестанет */
    }
  }

  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  /** Идентификатор клика: по нему рекламная система узнаёт свой переход. */
  function clickId() {
    return param('gclid') || param('yclid') || param('fbclid') || param('ysclid') || '';
  }

  /** client_id Метрики или GA, если они стоят на сайте. Нужен для возврата конверсий. */
  function analyticsId() {
    try {
      if (window.ym && window.Ya && Ya.Metrika2) {
        var counters = (window.Ya.Metrika2 && Ya.Metrika2.counters && Ya.Metrika2.counters()) || [];
        if (counters.length && counters[0].id) {
          var id = null;
          window.ym(counters[0].id, 'getClientID', function (v) {
            id = v;
          });
          if (id) return 'ym:' + id;
        }
      }
      var ga = document.cookie.match(/_ga=GA\d\.\d\.(\d+\.\d+)/);
      if (ga) return 'ga:' + ga[1];
    } catch (e) {
      /* аналитика не обязана быть на сайте */
    }
    return '';
  }

  function visitor() {
    var v = null;
    try {
      v = localStorage.getItem(STORE_VID);
    } catch (e) {
      v = null;
    }
    if (!v) {
      v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try {
        localStorage.setItem(STORE_VID, v);
      } catch (e) {
        /* ничего: тогда посетитель будет новым при каждом визите */
      }
    }
    return v;
  }

  /** Переход считается внешним, если он не с этого же домена. */
  function referrer() {
    var r = document.referrer || '';
    if (!r) return '';
    try {
      if (new URL(r).host === window.location.host) return '';
    } catch (e) {
      /* ссылка кривая — пусть едет как есть */
    }
    return r;
  }

  function touch() {
    return {
      at: new Date().toISOString(),
      source: param('utm_source'),
      medium: param('utm_medium'),
      campaign: param('utm_campaign'),
      content: param('utm_content'),
      term: param('utm_term'),
      clickId: clickId(),
      landing: window.location.href.slice(0, 500),
      referrer: referrer()
    };
  }

  var now = touch();
  var hasMarks = now.source || now.medium || now.clickId || now.referrer;
  var first = read(STORE_FIRST);
  // Первое касание пишется один раз и не переписывается — в этом весь смысл.
  // Исключение одно: первого нет вовсе.
  if (!first) {
    first = now;
    write(STORE_FIRST, first);
  }
  // Последнее обновляем только если визит что-то принёс: переход внутри сайта
  // не должен стирать «пришёл из поиска» на пустое.
  var last = read(STORE_LAST);
  if (hasMarks || !last) {
    last = now;
    write(STORE_LAST, last);
  }

  function marks(formCode) {
    return {
      visitorId: visitor(),
      landing: last.landing,
      referrer: last.referrer,
      source: last.source,
      medium: last.medium,
      campaign: last.campaign,
      content: last.content,
      term: last.term,
      clickId: last.clickId,
      analyticsId: analyticsId(),
      formCode: formCode || '',
      firstAt: first.at,
      firstSource: first.source,
      firstMedium: first.medium,
      firstCampaign: first.campaign,
      firstLanding: first.landing,
      firstReferrer: first.referrer
    };
  }

  /**
   * Отправка заявки. Возвращает промис: `true` — приняли, иначе текст ошибки.
   * Телефон или почта обязательны — иначе перезванивать некому.
   */
  function send(data) {
    var body = {
      key: KEY,
      name: data.name || '',
      phone: data.phone || '',
      email: data.email || '',
      comment: data.comment || '',
      company: data.company || '', // ловушка для ботов: человек её не заполняет
      marks: marks(data.formCode)
    };
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.ok) return true;
      return res
        .json()
        .then(function (j) {
          throw new Error((j && j.error && j.error.message) || 'Заявку принять не удалось');
        })
        .catch(function () {
          throw new Error('Заявку принять не удалось');
        });
    });
  }

  /**
   * Самоподключение к формам с атрибутом `data-metall-lead`.
   * Поля ищутся по именам: name, phone, email, comment.
   */
  function bind(form) {
    if (form.dataset.metallBound) return;
    form.dataset.metallBound = '1';

    // Ловушка: поле вне экрана, его не видно и не поймает автозаполнение.
    if (!form.querySelector('[name="company"]')) {
      var trap = document.createElement('input');
      trap.type = 'text';
      trap.name = 'company';
      trap.tabIndex = -1;
      trap.autocomplete = 'off';
      trap.setAttribute('aria-hidden', 'true');
      trap.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0';
      form.appendChild(trap);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = function (n) {
        var el = form.querySelector('[name="' + n + '"]');
        return el ? el.value : '';
      };
      var button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      send({
        name: val('name'),
        phone: val('phone'),
        email: val('email'),
        comment: val('comment') || val('message'),
        company: val('company'),
        formCode: form.dataset.metallLead || form.id || 'form'
      })
        .then(function () {
          form.dispatchEvent(new CustomEvent('metall-lead:ok', { bubbles: true }));
          form.reset();
        })
        .catch(function (err) {
          form.dispatchEvent(
            new CustomEvent('metall-lead:fail', { bubbles: true, detail: err.message })
          );
        })
        .then(function () {
          if (button) button.disabled = false;
        });
    });
  }

  function bindAll() {
    var forms = document.querySelectorAll('form[data-metall-lead]');
    for (var i = 0; i < forms.length; i++) bind(forms[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }

  window.MetallLead = { send: send, marks: marks, bind: bind, bindAll: bindAll };
})();
