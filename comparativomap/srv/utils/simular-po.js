// srv/simulate-po.js
const cds = require('@sap/cds'); // Importa o runtime do CAP para conectar no destino remoto (BAPI)

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

/**
 * Função principal que simula a criação de Pedido via BAPI_PO_CREATE1 em TESTRUN
 * Recebe itens do Ariba (linhas) e um cabeçalho do Ariba, adapta, valida, monta o payload
 * e chama a BAPI. Retorna mensagens + tabela de impostos para a UI.
 */
async function simularPO(itensDoAriba = [], cabecalhoDoAriba = {}) {
  console.log("========== [simularPO] INÍCIO ==========");
  logSafe("[simularPO] itensDoAriba (bruto)", itensDoAriba, { slice: 2 });
  logSafe("[simularPO] cabecalhoDoAriba (bruto)", cabecalhoDoAriba, { slice: 10 });

  // ==== helpers locais (escopo do módulo) ==================================
  const paraArray = x => Array.isArray(x) ? x : (x ? [x] : []); // Garante array
  const pad = (v, n) => String(v ?? '').padStart(n, '0');
  const num = v => Number(v || 0);
  const round2 = n => Math.round(num(n) * 100) / 100;
  const catExt2Int = s => ({ ' ': '0', L: '3', S: '5', E: 'A', K: '2' }[s] ?? s ?? '0');
  const itemNo = i => String((i + 1) * 10).padStart(5, '0');
  const MAPA_COND = {
    PBXX: 'precoBase', ICMS: 'icms', ZICM: 'icms', IPI: 'ipi', ZIPI: 'ipi',
    PIS: 'pis', ZPIS: 'pis', COF: 'cofins', ZCOF: 'cofins', ST: 'st', ZST: 'st', NAVS: 'frete'
  };

  /**
   * Normaliza um item vindo do Ariba para os nomes esperados na montagem do payload da BAPI.
   * Não altera o objeto original; cria um clone e preenche aliases/campos equivalentes.
   */
  const normalizarItem = r => {
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

    // LOG por item (resumo)
    console.log("[normalizarItem] =>", {
      MaterialCode: x.MaterialCode,
      itemDescription: x.itemDescription,
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
  };

  /**
   * Adapta o cabeçalho vindo do Ariba para os nomes esperados pelo payload da BAPI (POHEADER).
   */
  const adaptarCabecalho = h => {
    const out = {
      tipoPedido: h.tipoPedido || h.docCat,             // DOC_TYPE
      empresa: h.companyCode || h.compCode || h.company, // COMP_CODE
      organizacaoCompras: h.purchasingOrganization || h.purOrg, // PURCH_ORG
      grupoCompradores: h.purchasingGroup || h.purGroup, // PUR_GROUP
      fornecedor: h.fornecedor,                          // VENDOR (LIFNR)
      moeda: h.moeda || h.currency,                      // CURRENCY
      incoterms: h.incoterms1 || h.inc1,                 // INCOTERMS1
      localIncoterms: h.incoterms2 || h.inc2,            // INCOTERMS2
      condicaoPagamento: h.paymentTerms || h.pmnttrms    // PMNTTRMS
    };
    logSafe("[adaptarCabecalho] =>", out, { slice: 20 });
    return out;
  };

  /**
   * Valida campos obrigatórios do header e dos itens antes de chamar a BAPI (fail-fast).
   */
  const validarObrigatorios = (cab, itens) => {
    console.log("[validarObrigatorios] iniciando validações...");
    const faltas = [];

    // Header obrigatórios (BAPI_PO_CREATE1)
    if (!cab.tipoPedido) faltas.push('Tipo de Pedido (DOC_TYPE)');
    if (!cab.organizacaoCompras) faltas.push('Org. de Compras (PURCH_ORG)');
    if (!cab.grupoCompradores) faltas.push('Grp. Compradores (PUR_GROUP)');
    if (!cab.empresa) faltas.push('Empresa (COMP_CODE)');
    if (!cab.incoterms) faltas.push('Incoterms (INCOTERMS1)');
    if (!cab.localIncoterms) faltas.push('Local Incoterms (INCOTERMS2)');
    // if (!cab.condicaoPagamento) faltas.push('Condição de Pagamento (PMNTTRMS)');
    // if (!cab.fornecedor) faltas.push('Fornecedor (VENDOR/LIFNR)');
    if (!cab.moeda) faltas.push('Moeda (CURRENCY)');

    // Itens obrigatórios
    itens.forEach((r, idx) => {
      const i = itemNo(idx);
      if (!r.quantity) faltas.push(`Item ${i}: Quantity`);
      if (!r.unitOfMeasure) faltas.push(`Item ${i}: UnitOfMeasure`);
      if (r.price == null) faltas.push(`Item ${i}: Preço unitário (NET_PRICE)`);
      if (!r.currency) faltas.push(`Item ${i}: Moeda do item (currency)`);
      if (!r.PLANT) faltas.push(`Item ${i}: Centro (PLANT)`);
      if (!r.TAX_CODE) faltas.push(`Item ${i}: IVA (TAX_CODE)`);
      if (!r.MaterialCode && !r.itemDescription)
        faltas.push(`Item ${i}: Código do material (MATERIAL) OU Descrição (SHORT_TEXT)`);
      if (r.ItemCategory == null || r.ItemCategory === '')
        faltas.push(`Item ${i}: Categoria do item (ItemCategory)`);
      if (!r.grupo_de_materias)
        faltas.push(`Item ${i}: Grupo de materiais (MATL_GROUP)`);
      //if (!r.PREQ_NO) faltas.push(`Item ${i}: Código da requisição (PREQ_NO)`);
    });

    if (faltas.length) {
      console.error("[validarObrigatorios] FALHOU:", faltas);
      const err = new Error('Campos obrigatórios ausentes para a simulação:\n- ' + faltas.join('\n- '));
      err.userMessage = err.message;
      throw err;
    }
    console.log("[validarObrigatorios] OK (sem faltas).");
  };

  /**
   * Monta o payload exato que será enviado para a BAPI_PO_CREATE1.
   */
  const montarPayload = (cab, linhas) => {
    console.log("[montarPayload] Gerando estruturas POHEADER/POITEM...");
    const POHEADER = {
      COMP_CODE: cab.empresa,
      DOC_TYPE: cab.tipoPedido,
      VENDOR: pad(cab.fornecedor, 10),
      PURCH_ORG: cab.organizacaoCompras,
      PUR_GROUP: cab.grupoCompradores,
      CURRENCY: cab.moeda
    };
    if (cab.incoterms) POHEADER.INCOTERMS1 = cab.incoterms;
    if (cab.localIncoterms) POHEADER.INCOTERMS2 = cab.localIncoterms;
    if (cab.condicaoPagamento) POHEADER.PMNTTRMS = cab.condicaoPagamento;

    const POHEADERX = Object.fromEntries(Object.keys(POHEADER).map(k => [k, 'X']));
    const POITEM = [], POITEMX = [];

    linhas.forEach((r, idx) => {
      const PO_ITEM = itemNo(idx);

      // Validações “por-item” para mensagens claras
      if (!r?.PLANT) throw new Error(`Item ${PO_ITEM}: Centro (PLANT) é obrigatório`);
      if (!r?.quantity) throw new Error(`Item ${PO_ITEM}: Quantity é obrigatório`);
      if (!r?.unitOfMeasure) throw new Error(`Item ${PO_ITEM}: UnitOfMeasure é obrigatório`);
      if (r?.price == null) throw new Error(`Item ${PO_ITEM}: Preço unitário é obrigatório`);
      if (!r?.TAX_CODE) throw new Error(`Item ${PO_ITEM}: IVA (TAX_CODE) é obrigatório no BR`);

      const it = {
        PO_ITEM,
        PLANT: r.PLANT,
        QUANTITY: r.quantity,
        PO_UNIT: r.unitOfMeasure,
        NET_PRICE: r.price,
        TAX_CODE: String(r.TAX_CODE).trim().toUpperCase(),
        CALCTYPE: 'B'
      };

      if (r.MaterialCode) it.MATERIAL = String(r.MaterialCode).padStart(18, '0');
      else if (r.itemDescription) it.SHORT_TEXT = String(r.itemDescription).slice(0, 40);
      else throw new Error(`Item ${PO_ITEM}: informe MaterialCode ou itemDescription`);

      if (r.ItemCategory != null && r.ItemCategory !== '') it.ITEM_CAT = catExt2Int(r.ItemCategory);
      if (r.grupo_de_materias) it.MATL_GROUP = r.grupo_de_materias;
      if (r.PREQ_NO && r.PREQ_ITEM) {
        it.PREQ_NO = r.PREQ_NO;
        it.PREQ_ITEM = String(r.PREQ_ITEM).padStart(5, '0');
      }

      POITEM.push(it);

      const X = {
        PO_ITEM, PO_ITEMX: 'X',
        PLANT: 'X', QUANTITY: 'X', PO_UNIT: 'X', NET_PRICE: 'X', TAX_CODE: 'X', CALCTYPE: 'X'
      };
      if (it.MATERIAL) X.MATERIAL = 'X';
      if (it.SHORT_TEXT) X.SHORT_TEXT = 'X';
      if (it.ITEM_CAT) X.ITEM_CAT = 'X';
      if (it.MATL_GROUP) X.MATL_GROUP = 'X';
      if (it.PREQ_NO) X.PREQ_NO = 'X';
      if (it.PREQ_ITEM) X.PREQ_ITEM = 'X';

      POITEMX.push(X);

      // LOG de cada item montado (resumo)
      console.log("[montarPayload][ITEM]", {
        PO_ITEM: it.PO_ITEM,
        MATERIAL: it.MATERIAL,
        SHORT_TEXT: it.SHORT_TEXT,
        QUANTITY: it.QUANTITY,
        PO_UNIT: it.PO_UNIT,
        NET_PRICE: it.NET_PRICE,
        TAX_CODE: it.TAX_CODE,
        ITEM_CAT: it.ITEM_CAT,
        MATL_GROUP: it.MATL_GROUP,
        PREQ_NO: it.PREQ_NO,
        PREQ_ITEM: it.PREQ_ITEM
      });
    });

    logSafe("[montarPayload] POHEADER", POHEADER, { slice: 20 });
    logSafe("[montarPayload] POITEM (primeiros)", POITEM, { slice: 3 });

    return { POHEADER, POHEADERX, POITEM, POITEMX, TESTRUN: 'X' };
  };

  /**
   * Soma impostos e preço base por item a partir da tabela de condições (POCOND).
   */
  const calcularImpostosPorItem = (POCOND = []) => {
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
  };

  /**
   * Constrói a tabela consumível pelo front (fragment/tabela da simulação).
   */
  const montarTabelaItensParaFront = ({ payload, cabecalho, POCOND, POITEM_echo }) => {
    const impostos = calcularImpostosPorItem(POCOND);
    const moeda = cabecalho.moeda;
    return payload.POITEM.map(sent => {
      const eco = (POITEM_echo || []).find(e => e.PO_ITEM === sent.PO_ITEM) || {};
      const imp = impostos[sent.PO_ITEM] || { icms: 0, ipi: 0, pis: 0, cofins: 0, st: 0, precoBase: 0 };
      const precoTotal = round2(num(sent.QUANTITY) * num(sent.NET_PRICE));
      const precoBase = imp.precoBase || precoTotal;

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
  };

  // ==== fluxo principal =====================================================
  console.time("[simularPO] normalizar+adaptar");
  const itensNorm = itensDoAriba.map(normalizarItem);
  const cabAdaptado = adaptarCabecalho(cabecalhoDoAriba || {});

  // // Fallbacks úteis:
  // if (!cabAdaptado.moeda) {
  //   cabAdaptado.moeda = itensNorm.find(i => i.currency)?.currency || null;
  // }
  // if (!cabAdaptado.condicaoPagamento) {
  //   // Defina um default de testes (ajuste conforme o customizing). Ex.: '0001'
  //   cabAdaptado.condicaoPagamento = process.env.DEFAULT_PMNTTRMS || '0001';
  // }
  // // ATENÇÃO: VENDOR (fornecedor/LIFNR) é obrigatório pela BAPI; se faltar, falha.
  // // Se ainda não tem mapeamento Ariba->SAP, aceite um valor de DEV via .env:
  // if (!cabAdaptado.fornecedor && process.env.DEFAULT_LIFNR_DEV) {
  //   cabAdaptado.fornecedor = process.env.DEFAULT_LIFNR_DEV; // ex: '0000123456'
  // }
  console.timeEnd("[simularPO] normalizar+adaptar");

  logSafe("[simularPO] itensNorm (primeiros)", itensNorm, { slice: 2 });
  logSafe("[simularPO] cabAdaptado", cabAdaptado, { slice: 20 });

  try {
    console.time("[simularPO] validarObrigatorios");
    validarObrigatorios(cabAdaptado, itensNorm);
    console.timeEnd("[simularPO] validarObrigatorios");
  } catch (e) {
    console.error("[simularPO] validarObrigatorios ERRO:", e?.message);
    e.userMessage ||= e.message;
    console.log("========== [simularPO] FIM (falhou na validação) ==========");
    throw e;
  }

  console.time("[simularPO] montarPayload");
  const payload = montarPayload(cabAdaptado, itensNorm);
  console.timeEnd("[simularPO] montarPayload");

  logSafe("[simularPO] Payload.POHEADER", payload.POHEADER, { slice: 20 });
  logSafe("[simularPO] Payload.POITEM (primeiros)", payload.POITEM, { slice: 3 });
  console.log("[simularPO] TESTRUN =", payload.TESTRUN);

  let bruto;
  try {
    console.time("[simularPO] chamada BAPI");
    const bapi = await cds.connect.to('BAPI_PO_CREATE');
    console.log("[simularPO] Conectado ao destino 'BAPI_PO_CREATE'. Chamando BAPI_PO_CREATE1...");
    bruto = await bapi.send({ action: 'BAPI_PO_CREATE1', data: payload });
    console.timeEnd("[simularPO] chamada BAPI");
  } catch (e) {
    console.error("[simularPO] ERRO ao chamar BAPI:", e?.message || e);
    e.userMessage ||= "Falha ao chamar BAPI_PO_CREATE1 (ver logs do destino).";
    console.log("========== [simularPO] FIM (falhou na chamada da BAPI) ==========");
    throw e;
  }

  // Normalizações de retorno
  const RETURN = paraArray(bruto?.RETURN?.item || bruto?.RETURN);
  const POCOND = paraArray(bruto?.POCOND?.item || bruto?.POCOND);
  const POITEM_echo = paraArray(bruto?.POITEM?.item || bruto?.POITEM);

  console.log("[simularPO] Retorno BAPI: chaves =", Object.keys(bruto || {}));
  console.log("[simularPO] RETURN count =", RETURN.length);
  console.log("[simularPO] POCOND count =", POCOND.length);
  console.log("[simularPO] POITEM_echo count =", POITEM_echo.length);
  logSafe("[simularPO] RETURN (primeiras msgs)", RETURN, { slice: 5 });

  const success = !RETURN.some(m => m.TYPE === 'E' || m.TYPE === 'A');
  const messages = RETURN.map(m => ({ type: m.TYPE, text: m.MESSAGE }));

  console.log("[simularPO] success =", success);
  logSafe("[simularPO] messages", messages, { slice: 10 });

  const tabelaItens = montarTabelaItensParaFront({ payload, cabecalho: cabAdaptado, POCOND, POITEM_echo });
  logSafe("[simularPO] tabelaItens (primeiros)", tabelaItens, { slice: 3 });

  const resposta = {
    success,
    messages,
    purchaseOrder: bruto?.EXPPURCHASEORDER || null,
    tabelaItens
  };

  logSafe("[simularPO] RESPOSTA FINAL", resposta, { slice: 10 });
  console.log("========== [simularPO] FIM (OK) ==========");
  return resposta;
}

module.exports = { simularPO };
