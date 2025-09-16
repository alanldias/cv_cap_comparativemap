sap.ui.define(["sap/ui/util/Storage"], function (Storage) {
  "use strict";
  const KEY = "tblDocs-prefs";
  const storage = new Storage(Storage.Type.local, "comparativemap");
  function load() {
    try {
      const raw = storage.get(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      filter: { fornecedor: [], nomeItem: [] },
      sort: { key: null, desc: false },
      group: { key: null, desc: false },
    };
  }
  function save(prefs) {
    storage.put(KEY, JSON.stringify(prefs));
  }
  return { load, save };
});
