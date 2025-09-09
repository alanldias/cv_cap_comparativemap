// srv/simulate-po.js
'use strict';
const cds = require('@sap/cds'); // runtime CAP, para chamar a BAPI quando no modo real

/** ===================== FLAGS / AMBIENTE ===================== */
const PO_SIM_MODE      = (process.env.PO_SIM_MODE || 'mock').toLowerCase(); // 'mock' | 'real'
const PO_SIM_FALLBACK  = (process.env.PO_SIM_FALLBACK || 'true') === 'true';
const ICMS_DEFAULT_PCT = Number(process.env.PO_SIM_ICMS || 6);
const IPI_DEFAULT_PCT  = Number(process.env.PO_SIM_IPI  || 5);
const PO_SIM_STRICT    = (process.env.PO_SIM_STRICT || 'false') === 'true';

/** Utilitário: log “seguro” (limita tamanho de arrays/objetos gigantes) */
function logSafe(label, value, { slice = 3 } = {}) {
  try {
    if (Array.isArray(value)) {
      console.log(label, `(array len=${value.length})`, value.slice(0, slice));
    } else if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value);
      const preview = {};
      for (const k of keys.slice(0, slice)) preview[k] = value[k];
      console.log(label, `(keys=${keys.length > 20 ? keys.length : keys.join(",")})`, preview);
    } else {
      console.log(label, value);
    }
  } catch (e) {
    console.log(label, value);
  }
}

/** ===================== HELPERS COMUNS ===================== */
const paraArray = x => Array.isArray(x) ? x : (x ? [x] : []);
const pad       = (v, n) => String(v ?? '').padStart(n, '0');
const num       = v => Number(v || 0);
const round2    = n => Math.round(num(n) * 100) / 100;
const catExt2Int = s => ({ ' ': '0', L: '3', S: '5', E: 'A', K: '2' }[s] ?? s ?? '0');
const itemNo    = i => String((i + 1) * 10).padStart(5, '0');

const MAPA_COND = {
  PBXX: 'precoBase', ICMS: 'icms', ZICM: 'icms', IPI: 'ipi', ZIPI: 'ipi',
  PIS: 'pis', ZPIS: 'pis', COF: 'cofins', ZCOF: 'cofins', ST: 'st', ZST: 'st', NAVS: 'frete'
};

/** Normaliza item do Ariba para a montagem da BAPI / mock */
function normalizarItem(r) {
  const x = { ...r };
  // Aliases/Cópias
  if (x.iva && !x.TAX_CODE) x.TAX_CODE = String(x.iva).toUpperCase();
  if (!x.PLANT && x.centro) x.PLANT = x.centro;
  if (x.itemCategory != null && x.ItemCategory == null) x.ItemCategory = x.itemCategory;
  if (!x.grupo_de_materias && (x.grupoMateriais || x.MaterialGroup))
    x.grupo_de_materias = x.grupoMateriais || x.MaterialGroup;
  if (!x.MaterialCode && (x.materialCode || x.codigoMaterial))
    x.MaterialCode = x.materialCode || x.codigoMaterial;
  if (x.preco != null && x.price == null) x.price = x.preco;
  if (!x.currency && x.moeda) x.currency = x.moeda;
  if (!x.quantity && (x.quantidade != null)) x.quantity = x.quantidade;
  if (!x.unitOfMeasure && (x.unidade || x.PO_UNIT)) x.unitOfMeasure = x.unidade || x.PO_UNIT;
  if (!x.PREQ_NO && x.requisicao) x.PREQ_NO = x.requisicao;
  if (!x.PREQ_ITEM && x.requisicaoItem) x.PREQ_ITEM = x.requisicaoItem;

  console.log("[normalizarItem] =>", {
    MaterialCode: x.MaterialCode,
    itemDescription: x.itemDescription || x.itemDescription,
    quantity: x.quantity,
    unitOfMeasure: x.unitOfMeasure,
    price: x.price,
    currency: x.currency,
    PLANT: x.PLANT,
    TAX_CODE: x.TAX_CODE,
    ItemCategory: x.ItemCategory,
    grupo_de_materias: x.grupo_de_materias,
    PREQ_NO: x.PREQ_NO,
    PREQ_ITEM: x.PREQ_ITEM
  });
  return x;
}

/** Adapta cabeçalho Ariba para a BAPI */
function adaptarCabecalho(h) {
  const out = {
    tipoPedido: h.tipoPedido || h.docCat,                         // DOC_TYPE
    empresa: h.companyCode || h.compCode || h.company,            // COMP_CODE
    organizacaoCompras: h.purchasingOrganization || h.purOrg,     // PURCH_ORG
    grupoCompradores: h.purchasingGroup || h.purGroup,            // PUR_GROUP
    fornecedor: h.fornecedor,                                     // VENDOR (LIFNR)
    moeda: h.moeda || h.currency,                                 // CURRENCY
    incoterms: h.incoterms1 || h.inc1,                            // INCOTERMS1
    localIncoterms: h.incoterms2 || h.inc2,                       // INCOTERMS2
    condicaoPagamento: h.paymentTerms || h.pmnttrms               // PMNTTRMS
  };
  logSafe("[adaptarCabecalho] =>", out, { slice: 20 });
  return out;
}

/** Valida obrigatórios (padrão BAPI) */
function validarObrigatorios(cab, itens) {
  console.log("[validarObrigatorios] iniciando validações...");
  const faltas = [];

  // Header
  if (!cab.tipoPedido)         faltas.push('Tipo de Pedido (DOC_TYPE)');
  if (!cab.organizacaoCompras) faltas.push('Org. de Compras (PURCH_ORG)');
  if (!cab.grupoCompradores)   faltas.push('Grp. Compradores (PUR_GROUP)');
  if (!cab.empresa)            faltas.push('Empresa (COMP_CODE)');
  if (!cab.incoterms)          faltas.push('Incoterms (INCOTERMS1)');
  if (!cab.localIncoterms)     faltas.push('Local Incoterms (INCOTERMS2)');
  if (!cab.moeda)              faltas.push('Moeda (CURRENCY)');

  // Itens
  itens.forEach((r, idx) => {
    const i = itemNo(idx);
    if (!r.quantity)         faltas.push(`Item ${i}: Quantity`);
    if (!r.unitOfMeasure)    faltas.push(`Item ${i}: UnitOfMeasure`);
    if (r.price == null)     faltas.push(`Item ${i}: Preço unitário (NET_PRICE)`);
    if (!r.currency)         faltas.push(`Item ${i}: Moeda do item (currency)`);
    if (!r.PLANT)            faltas.push(`Item ${i}: Centro (PLANT)`);
    if (!r.TAX_CODE)         faltas.push(`Item ${i}: IVA (TAX_CODE)`);
    if (!r.MaterialCode && !r.itemDescription && !r.itemDescription)
                              faltas.push(`Item ${i}: Código (MATERIAL) OU Descrição (SHORT_TEXT)`);
    if (r.ItemCategory == null || r.ItemCategory === '')
                              faltas.push(`Item ${i}: Categoria do item (ItemCategory)`);
    if (!r.grupo_de_materias) faltas.push(`Item ${i}: Grupo de materiais (MATL_GROUP)`);
  });

  if (faltas.length) {
    const err = new Error('Campos obrigatórios ausentes para a simulação:\n- ' + faltas.join('\n- '));
    err.userMessage = err.message;
    throw err;
  }
  console.log("[validarObrigatorios] OK (sem faltas).");
}

/** Monta payload da BAPI */
function montarPayload(cab, linhas) {
  console.log("[montarPayload] Gerando estruturas POHEADER/POITEM...");
  const POHEADER = {
    COMP_CODE: cab.empresa,
    DOC_TYPE:  cab.tipoPedido,
    VENDOR:    pad(cab.fornecedor, 10),
    PURCH_ORG: cab.organizacaoCompras,
    PUR_GROUP: cab.grupoCompradores,
    CURRENCY:  cab.moeda
  };
  if (cab.incoterms)      POHEADER.INCOTERMS1 = cab.incoterms;
  if (cab.localIncoterms) POHEADER.INCOTERMS2 = cab.localIncoterms;
  if (cab.condicaoPagamento) POHEADER.PMNTTRMS = cab.condicaoPagamento;

  const POHEADERX = Object.fromEntries(Object.keys(POHEADER).map(k => [k, 'X']));
  const POITEM = [], POITEMX = [];

  linhas.forEach((r, idx) => {
    const PO_ITEM = itemNo(idx);
    if (!r?.PLANT)         throw new Error(`Item ${PO_ITEM}: Centro (PLANT) é obrigatório`);
    if (!r?.quantity)      throw new Error(`Item ${PO_ITEM}: Quantity é obrigatório`);
    if (!r?.unitOfMeasure) throw new Error(`Item ${PO_ITEM}: UnitOfMeasure é obrigatório`);
    if (r?.price == null)  throw new Error(`Item ${PO_ITEM}: Preço unitário é obrigatório`);
    if (!r?.TAX_CODE)      throw new Error(`Item ${PO_ITEM}: IVA (TAX_CODE) é obrigatório no BR`);

    const it = {
      PO_ITEM,
      PLANT:      r.PLANT,
      QUANTITY:   r.quantity,
      PO_UNIT:    r.unitOfMeasure,
      NET_PRICE:  r.price,
      TAX_CODE:   String(r.TAX_CODE).trim().toUpperCase(),
      CALCTYPE:   'B'
    };

    if (r.MaterialCode) it.MATERIAL   = String(r.MaterialCode).padStart(18, '0');
    else if (r.itemDescription || r.itemDescription) it.SHORT_TEXT = String(r.itemDescription || r.itemDescription).slice(0, 40);
    else throw new Error(`Item ${PO_ITEM}: informe MaterialCode ou itemDescription`);

    if (r.ItemCategory != null && r.ItemCategory !== '') it.ITEM_CAT   = catExt2Int(r.ItemCategory);
    if (r.grupo_de_materias) it.MATL_GROUP = r.grupo_de_materias;
    if (r.PREQ_NO && r.PREQ_ITEM) {
      it.PREQ_NO   = r.PREQ_NO;
      it.PREQ_ITEM = String(r.PREQ_ITEM).padStart(5, '0');
    }

    POITEM.push(it);

    const X = {
      PO_ITEM, PO_ITEMX: 'X',
      PLANT: 'X', QUANTITY: 'X', PO_UNIT: 'X', NET_PRICE: 'X', TAX_CODE: 'X', CALCTYPE: 'X'
    };
    if (it.MATERIAL)   X.MATERIAL   = 'X';
    if (it.SHORT_TEXT) X.SHORT_TEXT = 'X';
    if (it.ITEM_CAT)   X.ITEM_CAT   = 'X';
    if (it.MATL_GROUP) X.MATL_GROUP = 'X';
    if (it.PREQ_NO)    X.PREQ_NO    = 'X';
    if (it.PREQ_ITEM)  X.PREQ_ITEM  = 'X';

    POITEMX.push(X);
  });

  logSafe("[montarPayload] POHEADER", POHEADER, { slice: 20 });
  logSafe("[montarPayload] POITEM (primeiros)", POITEM, { slice: 3 });

  return { POHEADER, POHEADERX, POITEM, POITEMX, TESTRUN: 'X' };
}

/** Agrega condições de retorno da BAPI por item */
function calcularImpostosPorItem(POCOND = []) {
  const porItem = {};
  for (const c of POCOND) {
    const it = c.ITM_NUMBER; if (!it) continue;
    porItem[it] ??= { icms: 0, ipi: 0, pis: 0, cofins: 0, st: 0, precoBase: 0 };
    const chave = MAPA_COND[c.COND_TYPE]; const valor = num(c.COND_VALUE);
    if (!chave) continue;
    if (chave === 'precoBase') porItem[it].precoBase += valor;
    else porItem[it][chave] += valor;
  }
  for (const it of Object.keys(porItem))
    for (const k of Object.keys(porItem[it]))
      porItem[it][k] = round2(porItem[it][k]);
  return porItem;
}

/** Monta tabela para UI a partir do eco e condições da BAPI */
function montarTabelaItensParaFront({ payload, cabecalho, POCOND, POITEM_echo }) {
  const impostos = calcularImpostosPorItem(POCOND);
  const moeda    = cabecalho.moeda;
  return payload.POITEM.map(sent => {
    const eco = (POITEM_echo || []).find(e => e.PO_ITEM === sent.PO_ITEM) || {};
    const imp = impostos[sent.PO_ITEM] || { icms: 0, ipi: 0, pis: 0, cofins: 0, st: 0, precoBase: 0 };
    const precoTotal = round2(num(sent.QUANTITY) * num(sent.NET_PRICE));
    const precoBase  = imp.precoBase || precoTotal;

    return {
      item: sent.PO_ITEM,
      material: sent.MATERIAL || '',
      descricao: eco.SHORT_TEXT || sent.SHORT_TEXT || '',
      centro: sent.PLANT,
      quantidade: num(sent.QUANTITY),
      unidade: sent.PO_UNIT,
      precoUnitario: round2(sent.NET_PRICE),
      precoTotal,
      taxCode: sent.TAX_CODE,
      icms: imp.icms, ipi: imp.ipi, pis: imp.pis, cofins: imp.cofins, st: imp.st,
      precoBase,
      moeda,
      grupoMateriais: sent.MATL_GROUP || '',
      categoriaItem: sent.ITEM_CAT || '',
      preqNo: sent.PREQ_NO || '',
      preqItem: sent.PREQ_ITEM || ''
    };
  });
}

/** ===================== MOCK BUILDER ===================== */
function buildMockResponse(itensNorm, cabAdaptado, { addWarning } = {}) {
  // Gera uma “tabelaItens” semelhante ao eco da BAPI
  const tabelaItens = itensNorm.map((it, idx) => {
    const ebelp = ((idx + 1) * 10).toString().padStart(5, '0');
    const q     = num(it.quantity);
    const p     = num(it.price);
    const icms  = round2(q * p * (ICMS_DEFAULT_PCT / 100));
    const ipi   = round2(q * p * (IPI_DEFAULT_PCT  / 100));
    return {
      ebeln   : null,                      // em TESTRUN, geralmente vazio
      ebelp,
      lifnr   : (it.lifnr || '').toString().padStart(10, '0'),
      matnr   : it.MaterialCode || null,
      txz01   : it.itemDescription || it.itemDescription || null,
      menge   : q,
      meins   : it.unitOfMeasure || 'UN',
      netpr   : p,
      waers   : it.currency || cabAdaptado.moeda || 'BRL',
      tax_code: it.TAX_CODE || null,
      plant   : it.PLANT || null,
      _calc   : { icms, ipi, total: round2(q * p) }
    };
  });

  // Linhas para o seu fragment: res>/rows
  const rows = tabelaItens.map((t, i) => ({
    supplierName : itensNorm[i]?.supplierName || itensNorm[i]?.fornecedorNome || itensNorm[i]?.lifnr || '',
    materialCode : t.matnr || '',
    quantity     : t.menge,
    price        : t.netpr,
    currency     : t.waers,
    icms         : t._calc.icms,
    ipi          : t._calc.ipi,
    total        : t._calc.total
  }));

  const messages = [
    ...(addWarning ? [{ type: 'W', text: 'Resposta MOCK utilizada (BAPI não chamada).' }] : []),
    { type: 'S', text: 'Simulação concluída (mock).' }
  ];

  return {
    success: true,
    messages,
    purchaseOrder: null,
    tabelaItens,
    rows
  };
}

/** ===================== FUNÇÃO PRINCIPAL ===================== */
async function simularPO(itensDoAriba = [], cabecalhoDoAriba = {}) {
  console.log("========== [simularPO] INÍCIO ==========");
  console.log(`[simularPO] PO_SIM_MODE=${PO_SIM_MODE} | PO_SIM_FALLBACK=${PO_SIM_FALLBACK} | STRICT=${PO_SIM_STRICT}`);
  logSafe("[simularPO] itensDoAriba (bruto)", itensDoAriba, { slice: 2 });
  logSafe("[simularPO] cabecalhoDoAriba (bruto)", cabecalhoDoAriba, { slice: 10 });

  // Normalização
  console.time("[simularPO] normalizar+adaptar");
  const itensNorm    = itensDoAriba.map(normalizarItem);
  const cabAdaptado  = adaptarCabecalho(cabecalhoDoAriba || {});
  console.timeEnd("[simularPO] normalizar+adaptar");

  // Se estiver em MOCK, valida só se pediu STRICT; caso contrário, deixa passar
  if (PO_SIM_MODE === 'mock' && !PO_SIM_STRICT) {
    logSafe("[simularPO][mock] itensNorm (preview)", itensNorm, { slice: 2 });
    const mock = buildMockResponse(itensNorm, cabAdaptado, { addWarning: false });
    logSafe("[simularPO][mock] RESPOSTA FINAL", mock, { slice: 10 });
    console.log("========== [simularPO] FIM (MOCK) ==========");
    return mock;
  }

  // Modo real (ou mock+strict): valida obrigatórios
  try {
    console.time("[simularPO] validarObrigatorios");
    validarObrigatorios(cabAdaptado, itensNorm);
    console.timeEnd("[simularPO] validarObrigatorios");
  } catch (e) {
    console.error("[simularPO] validarObrigatorios ERRO:", e?.message);
    e.userMessage ||= e.message;
    if (PO_SIM_MODE === 'real' && PO_SIM_FALLBACK) {
      console.warn("[simularPO] STRICT violado, mas farei FALLBACK para MOCK.");
      const mock = buildMockResponse(itensNorm, cabAdaptado, { addWarning: true });
      return mock;
    }
    console.log("========== [simularPO] FIM (falhou na validação) ==========");
    throw e;
  }

  // Se for REAL, chama a BAPI; se der erro e FALLBACK habilitado, devolve MOCK
  if (PO_SIM_MODE === 'real') {
    let bruto;
    try {
      console.time("[simularPO] chamada BAPI");
      const bapi = await cds.connect.to('BAPI_PO_CREATE');
      console.log("[simularPO] Conectado ao destino 'BAPI_PO_CREATE'. Chamando BAPI_PO_CREATE1...");
      const payload = montarPayload(cabAdaptado, itensNorm);
      bruto = await bapi.send({ action: 'BAPI_PO_CREATE1', data: payload });
      console.timeEnd("[simularPO] chamada BAPI");

      // Normalizações
      const RETURN       = paraArray(bruto?.RETURN?.item || bruto?.RETURN);
      const POCOND       = paraArray(bruto?.POCOND?.item || bruto?.POCOND);
      const POITEM_echo  = paraArray(bruto?.POITEM?.item || bruto?.POITEM);

      console.log("[simularPO] Retorno BAPI: chaves =", Object.keys(bruto || {}));
      console.log("[simularPO] RETURN count =", RETURN.length, "POCOND count =", POCOND.length, "POITEM_echo count =", POITEM_echo.length);

      const success  = !RETURN.some(m => m.TYPE === 'E' || m.TYPE === 'A');
      const messages = RETURN.map(m => ({ type: m.TYPE, text: m.MESSAGE }));

      const payloadEco = montarPayload(cabAdaptado, itensNorm); // reusa estrutura para mapear por posição
      const tabelaItens = montarTabelaItensParaFront({ payload: payloadEco, cabecalho: cabAdaptado, POCOND, POITEM_echo });

      // rows p/ fragment
      const rows = tabelaItens.map((t, i) => ({
        supplierName : itensNorm[i]?.supplierName || itensNorm[i]?.fornecedorNome || itensNorm[i]?.lifnr || '',
        materialCode : t.material || '',
        quantity     : t.quantidade,
        price        : t.precoUnitario,
        currency     : t.moeda,
        icms         : t.icms,
        ipi          : t.ipi,
        total        : t.precoTotal
      }));

      const resposta = {
        success,
        messages,
        purchaseOrder: bruto?.EXPPURCHASEORDER || null,
        tabelaItens,
        rows
      };
      logSafe("[simularPO] RESPOSTA FINAL (REAL)", resposta, { slice: 10 });
      console.log("========== [simularPO] FIM (REAL) ==========");
      return resposta;

    } catch (e) {
      console.error("[simularPO] ERRO ao chamar BAPI:", e?.message || e);
      if (PO_SIM_FALLBACK) {
        console.warn("[simularPO] FALLBACK para MOCK por erro na BAPI.");
        const mock = buildMockResponse(itensNorm, cabAdaptado, { addWarning: true });
        return mock;
      }
      e.userMessage ||= "Falha ao chamar BAPI_PO_CREATE1 (ver logs do destino).";
      console.log("========== [simularPO] FIM (erro sem fallback) ==========");
      throw e;
    }
  }

  // Se chegou aqui, é MOCK+STRICT (validou, mas não chama BAPI)
  const mock = buildMockResponse(itensNorm, cabAdaptado, { addWarning: false });
  logSafe("[simularPO][mock+strict] RESPOSTA FINAL", mock, { slice: 10 });
  console.log("========== [simularPO] FIM (MOCK+STRICT) ==========");
  return mock;
}

module.exports = { simularPO };
