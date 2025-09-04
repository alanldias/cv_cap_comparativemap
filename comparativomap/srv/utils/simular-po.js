// srv/simulate-po.js
const cds = require('@sap/cds'); // Importa o runtime do CAP para conectar no destino remoto (BAPI)

/**
 * Função principal que simula a criação de Pedido via BAPI_PO_CREATE1 em TESTRUN
 * Recebe itens do Ariba (linhas) e um cabeçalho do Ariba, adapta, valida, monta o payload
 * e chama a BAPI. Retorna mensagens + tabela de impostos para a UI.
 */
async function simularPO(itensDoAriba = [], cabecalhoDoAriba = {}) {
  // ==== helpers locais (escopo do módulo) ==================================
  const paraArray = x => Array.isArray(x) ? x : (x ? [x] : []);                  // Garante array: se vier objeto único/undefined, normaliza para lista
  const pad = (v, n) => String(v ?? '').padStart(n, '0');                  // Preenche à esquerda com zeros; usado para VENDOR, MATERIAL etc.
  const num = v => Number(v || 0);                                         // Converte para número com fallback 0
  const round2 = n => Math.round(num(n) * 100) / 100;                         // Arredonda para 2 casas decimais
  const catExt2Int = s => ({ ' ': '0', L: '3', S: '5', E: 'A', K: '2' }[s] ?? s ?? '0'); // Converte categoria externa (Ariba/UI) para interna (SAP)
  const itemNo = i => String((i + 1) * 10).padStart(5, '0');                  // Gera número de item SAP (00010, 00020, ...)
  const MAPA_COND = { PBXX: 'precoBase', ICMS: 'icms', ZICM: 'icms', IPI: 'ipi', ZIPI: 'ipi', PIS: 'pis', ZPIS: 'pis', COF: 'cofins', ZCOF: 'cofins', ST: 'st', ZST: 'st', NAVS: 'frete' }; // Mapeia tipos de condição SAP -> rótulos usados no somatório

  /**
   * Normaliza um item vindo do Ariba para os nomes esperados na montagem do payload da BAPI.
   * Não altera o objeto original; cria um clone e preenche aliases/campos equivalentes.
   */
  const normalizarItem = r => {
    const x = { ...r };                                                             // Clona o item original para não mutar o retorno do Ariba
    if (x.iva && !x.TAX_CODE) x.TAX_CODE = String(x.iva).toUpperCase();            // Se vier "iva", espelha em TAX_CODE (usado pela BAPI)
    if (!x.PLANT && x.centro) x.PLANT = x.centro;                                   // Se vier "centro", espelha em PLANT (SAP)
    if (x.itemCategory != null && x.ItemCategory == null) x.ItemCategory = x.itemCategory; // Uniformiza ItemCategory (variação de caixa/chave)
    if (!x.grupo_de_materias && (x.grupoMateriais || x.MaterialGroup))
      x.grupo_de_materias = x.grupoMateriais || x.MaterialGroup;                    // Normaliza nome do grupo de materiais
    if (!x.MaterialCode && (x.materialCode || x.codigoMaterial))
      x.MaterialCode = x.materialCode || x.codigoMaterial;                          // Normaliza código do material (variações de nome)
    if (x.preco != null && x.price == null) x.price = x.preco;                      // Se vier "preco", espelha em "price"
    if (!x.currency && x.moeda) x.currency = x.moeda;                               // Se vier "moeda", espelha em "currency" (apenas para consistência)
    if (!x.quantity && (x.quantidade != null)) x.quantity = x.quantidade;           // Se vier "quantidade", espelha em "quantity"
    if (!x.unitOfMeasure && (x.unidade || x.PO_UNIT)) x.unitOfMeasure = x.unidade || x.PO_UNIT; // Se vier "unidade"/"PO_UNIT", espelha em unitOfMeasure
    if (!x.PREQ_NO && x.requisicao) x.PREQ_NO = x.requisicao;                       // Normaliza número da requisição de compra (se existir)
    if (!x.PREQ_ITEM && x.requisicaoItem) x.PREQ_ITEM = x.requisicaoItem;           // Normaliza item da requisição (se existir)
    return x;                                                                        // Retorna o clone normalizado
  };

  /**
   * Adapta o cabeçalho vindo do Ariba para os nomes esperados pelo payload da BAPI (POHEADER).
   * Sem defaults/inferências: apenas mapeamento 1:1 de nomes.
   */
  const adaptarCabecalho = h => ({
    tipoPedido: h.tipoPedido || h.docCat,                                  // DOC_TYPE
    empresa: h.companyCode || h.compCode || h.company,                  // COMP_CODE
    organizacaoCompras: h.purchasingOrganization || h.purOrg,                      // PURCH_ORG
    grupoCompradores: h.purchasingGroup || h.purGroup,                           // PUR_GROUP
    fornecedor: h.fornecedor,                                              // VENDOR (LIFNR)
    moeda: h.moeda || h.currency,                                     // CURRENCY
    incoterms: h.incoterms1 || h.inc1,                                    // INCOTERMS1
    localIncoterms: h.incoterms2 || h.inc2,                                    // INCOTERMS2
    condicaoPagamento: h.paymentTerms || h.pmnttrms                               // PMNTTRMS
  });

  /**
   * Valida campos obrigatórios do header e dos itens antes de chamar a BAPI (fail-fast).
   * Se algo estiver faltando, lança um erro com mensagem amigável (userMessage).
   */
  const validarObrigatorios = (cab, itens) => {
    const faltas = [];                                                               // Acumula mensagens de campos faltantes

    // Header obrigatórios (BAPI_PO_CREATE1)
    if (!cab.tipoPedido) faltas.push('Tipo de Pedido (DOC_TYPE)');          // Tipo de documento (ex.: NB)
    if (!cab.organizacaoCompras) faltas.push('Org. de Compras (PURCH_ORG)');        // Organização de compras
    if (!cab.grupoCompradores) faltas.push('Grp. Compradores (PUR_GROUP)');       // Grupo de compradores
    if (!cab.empresa) faltas.push('Empresa (COMP_CODE)');                // Código da empresa
    if (!cab.incoterms) faltas.push('Incoterms (INCOTERMS1)');             // Incoterms parte 1
    if (!cab.localIncoterms) faltas.push('Local Incoterms (INCOTERMS2)');       // Incoterms parte 2 (lugar)
    if (!cab.condicaoPagamento) faltas.push('Condição de Pagamento (PMNTTRMS)');   // Condição de pagamento
    if (!cab.fornecedor) faltas.push('Fornecedor (VENDOR/LIFNR)');          // Fornecedor (LIFNR)
    if (!cab.moeda) faltas.push('Moeda (CURRENCY)');                   // Moeda padrão do pedido

    // Itens obrigatórios (por item)
    itens.forEach((r, idx) => {
      const i = itemNo(idx);                                                         // Calcula número do item SAP para mensagens
      if (!r.quantity) faltas.push(`Item ${i}: Quantity`);                    // Quantidade
      if (!r.unitOfMeasure) faltas.push(`Item ${i}: UnitOfMeasure`);               // Unidade de medida
      if (r.price == null) faltas.push(`Item ${i}: Preço unitário (NET_PRICE)`);  // Preço unitário
      if (!r.currency) faltas.push(`Item ${i}: Moeda do item (currency)`);    // (No seu fluxo: exigido; pode tornar apenas coerência com header)
      if (!r.PLANT) faltas.push(`Item ${i}: Centro (PLANT)`);              // Centro (plant)
      if (!r.TAX_CODE) faltas.push(`Item ${i}: IVA (TAX_CODE)`);              // Código de imposto (IVA)
      if (!r.MaterialCode && !r.itemDescription)
        faltas.push(`Item ${i}: Código do material (MATERIAL) OU Descrição (SHORT_TEXT)`); // Material OU texto curto é obrigatório
      if (r.ItemCategory == null || r.ItemCategory === '')
        faltas.push(`Item ${i}: Categoria do item (ItemCategory)`);                  // Categoria do item (ex.: normal/serviço/etc.)
      if (!r.grupo_de_materias)
        faltas.push(`Item ${i}: Grupo de materiais (MATL_GROUP)`);                   // Grupo de materiais
      if (!r.PREQ_NO)
        faltas.push(`Item ${i}: Código da requisição (PREQ_NO)`);                    // Nº da requisição (se seu processo exigir)
    });

    // Se houve alguma falta, lança erro com mensagem agregada
    if (faltas.length) {
      const err = new Error('Campos obrigatórios ausentes para a simulação:\n- ' + faltas.join('\n- ')); // Monta mensagem listando faltas
      err.userMessage = err.message;                                                  // userMessage: exibível para UI
      throw err;                                                                      // Interrompe o fluxo antes de chamar a BAPI
    }
  };

  /**
   * Monta o payload exato que será enviado para a BAPI_PO_CREATE1.
   * Retorna POHEADER/POHEADERX (cabeçalho), POITEM/POITEMX (itens) e TESTRUN='X' (simulação).
   */
  const montarPayload = (cab, linhas) => {
    const POHEADER = {
      COMP_CODE: cab.empresa,                                                        // Código da empresa
      DOC_TYPE: cab.tipoPedido,                                                     // Tipo do documento (sem default)
      VENDOR: pad(cab.fornecedor, 10),                                            // Fornecedor (LIFNR) padLeft 10
      PURCH_ORG: cab.organizacaoCompras,                                             // Organização de compras
      PUR_GROUP: cab.grupoCompradores,                                               // Grupo de compradores
      CURRENCY: cab.moeda                                                           // Moeda do pedido (governa todos os itens)
    };
    if (cab.incoterms) POHEADER.INCOTERMS1 = cab.incoterms;                   // Incoterms parte 1 (opcional)
    if (cab.localIncoterms) POHEADER.INCOTERMS2 = cab.localIncoterms;              // Incoterms parte 2 (opcional)
    if (cab.condicaoPagamento) POHEADER.PMNTTRMS = cab.condicaoPagamento;           // Condição de pagamento (opcional)

    const POHEADERX = Object.fromEntries(Object.keys(POHEADER).map(k => [k, 'X']));   // Marca todos campos do header como “preenchidos” para a BAPI
    const POITEM = [], POITEMX = [];                                                  // Arrays de itens e seus marcadores X

    // Para cada linha normalizada do Ariba, gera um item de pedido SAP
    linhas.forEach((r, idx) => {
      const PO_ITEM = itemNo(idx);                                                    // Número do item (00010, 00020, ...)
      // Validações de sanidade por item (além das validações gerais)
      if (!r?.PLANT) throw new Error(`Item ${PO_ITEM}: Centro (PLANT) é obrigatório`);
      if (!r?.quantity) throw new Error(`Item ${PO_ITEM}: Quantity é obrigatório`);
      if (!r?.unitOfMeasure) throw new Error(`Item ${PO_ITEM}: UnitOfMeasure é obrigatório`);
      if (r?.price == null) throw new Error(`Item ${PO_ITEM}: Preço unitário é obrigatório`);
      if (!r?.TAX_CODE) throw new Error(`Item ${PO_ITEM}: IVA (TAX_CODE) é obrigatório no BR`);

      // Monta a estrutura do item conforme a BAPI espera (POITEM)
      const it = {
        PO_ITEM,                                                                       // Nº do item
        PLANT: r.PLANT,                                                            // Centro
        QUANTITY: r.quantity,                                                         // Quantidade
        PO_UNIT: r.unitOfMeasure,                                                    // Unidade de medida
        NET_PRICE: r.price,                                                            // Preço unitário
        TAX_CODE: String(r.TAX_CODE).trim().toUpperCase(),                            // Código de imposto (normalizado maiúsculo/trim)
        CALCTYPE: 'B' // redetermina pricing/impostos                                   // Força redeterminação de condições/impostos
      };
      if (r.MaterialCode) it.MATERIAL = String(r.MaterialCode).padStart(18, '0'); // Código do material (padLeft 18, padrão SAP)
      else if (r.itemDescription) it.SHORT_TEXT = String(r.itemDescription).slice(0, 40);   // Ou um texto curto (máx. 40 chars)
      else throw new Error(`Item ${PO_ITEM}: informe MaterialCode ou itemDescription`);     // Se nenhum dos dois, lança erro

      if (r.ItemCategory != null && r.ItemCategory !== '') it.ITEM_CAT = catExt2Int(r.ItemCategory); // Categoria do item (convertida p/ interna)
      if (r.grupo_de_materias) it.MATL_GROUP = r.grupo_de_materias;       // Grupo de materiais
      if (r.PREQ_NO && r.PREQ_ITEM) {
        it.PREQ_NO = r.PREQ_NO;                                                       // Nº da requisição de compra (se existir)
        it.PREQ_ITEM = String(r.PREQ_ITEM).padStart(5, '0');                            // Item da requisição (padLeft 5)
      }

      POITEM.push(it);                                                                  // Adiciona o item ao array

      // POITEMX: marca quais campos do item foram preenchidos e devem ser considerados pela BAPI
      const X = {
        PO_ITEM, PO_ITEMX: 'X',                                                          // ID do item + flag do próprio item
        PLANT: 'X', QUANTITY: 'X', PO_UNIT: 'X', NET_PRICE: 'X', TAX_CODE: 'X', CALCTYPE: 'X' // Flags de campos principais
      };
      if (it.MATERIAL) X.MATERIAL = 'X';                                            // Marca MATERIAL se usado
      if (it.SHORT_TEXT) X.SHORT_TEXT = 'X';                                            // Marca SHORT_TEXT se usado
      if (it.ITEM_CAT) X.ITEM_CAT = 'X';                                            // Marca ITEM_CAT se usado
      if (it.MATL_GROUP) X.MATL_GROUP = 'X';                                            // Marca MATL_GROUP se usado
      if (it.PREQ_NO) X.PREQ_NO = 'X';                                            // Marca PREQ_NO se usado
      if (it.PREQ_ITEM) X.PREQ_ITEM = 'X';                                            // Marca PREQ_ITEM se usado

      POITEMX.push(X);                                                                  // Adiciona o marcador X do item
    });

    return { POHEADER, POHEADERX, POITEM, POITEMX, TESTRUN: 'X' };                      // TESTRUN='X' => simulação (não grava PO)
  };

  /**
   * Soma impostos e preço base por item a partir da tabela de condições (POCOND) retornada pela BAPI.
   * Converte valores, agrega por ITM_NUMBER e arredonda para 2 casas.
   */
  const calcularImpostosPorItem = (POCOND = []) => {
    const porItem = {};                                                                 // Acumula somatórios por item
    for (const c of POCOND) {
      const it = c.ITM_NUMBER; if (!it) continue;                                       // Pula registros sem número de item
      porItem[it] ??= { icms: 0, ipi: 0, pis: 0, cofins: 0, st: 0, precoBase: 0 };            // Inicializa acumuladores do item
      const chave = MAPA_COND[c.COND_TYPE]; const valor = num(c.COND_VALUE);            // Mapeia tipo de condição -> rótulo; valor numérico
      if (!chave) continue;                                                             // Se condição não mapeada, ignora (ex.: descontos sem interesse)
      if (chave === 'precoBase') porItem[it].precoBase += valor;                        // PBXX => soma no preço base
      else porItem[it][chave] += valor;                                                 // Demais impostos => soma no respectivo acumulador
    }
    for (const it of Object.keys(porItem))                                              // Arredonda todos acumuladores
      for (const k of Object.keys(porItem[it]))
        porItem[it][k] = round2(porItem[it][k]);
    return porItem;                                                                     // Retorna mapa { '00010': {icms, ipi, ...}, ... }
  };

  /**
   * Constrói a tabela consumível pelo front (fragment/tabela da simulação),
   * combinando o payload enviado (POITEM) + eco de POITEM + somatórios de POCOND.
   */
  const montarTabelaItensParaFront = ({ payload, cabecalho, POCOND, POITEM_echo }) => {
    const impostos = calcularImpostosPorItem(POCOND);                                   // Calcula somatórios por item a partir de POCOND
    const moeda = cabecalho.moeda;                                                      // Moeda do header (governa o pedido)
    return payload.POITEM.map(sent => {                                                 // Para cada item enviado...
      const eco = (POITEM_echo || []).find(e => e.PO_ITEM === sent.PO_ITEM) || {};      // Tenta achar a descrição ecoada pela BAPI (SHORT_TEXT)
      const imp = impostos[sent.PO_ITEM] || { icms: 0, ipi: 0, pis: 0, cofins: 0, st: 0, precoBase: 0 }; // Impostos do item (ou zeros)
      const precoTotal = round2(num(sent.QUANTITY) * num(sent.NET_PRICE));              // Preço total = quantidade * preço unitário
      const precoBase = imp.precoBase || precoTotal;                                   // Preço base (se PBXX não vier, usa o total)

      return {
        item: sent.PO_ITEM,                                                             // Nº do item
        material: sent.MATERIAL || '',                                                  // Material (ou vazio se foi por SHORT_TEXT)
        descricao: eco.SHORT_TEXT || sent.SHORT_TEXT || '',                             // Descrição (preferindo eco; senão, a enviada)
        centro: sent.PLANT,                                                             // Centro
        quantidade: num(sent.QUANTITY),                                                 // Quantidade (numérico)
        unidade: sent.PO_UNIT,                                                          // Unidade
        precoUnitario: round2(sent.NET_PRICE),                                          // Preço unitário arredondado
        precoTotal,                                                                     // Preço total arredondado
        taxCode: sent.TAX_CODE,                                                         // Código de imposto (TAX_CODE / IVA)
        icms: imp.icms, ipi: imp.ipi, pis: imp.pis, cofins: imp.cofins, st: imp.st,     // Somatórios de impostos do item
        precoBase,                                                                      // Preço base (PBXX) do item
        moeda,                                                                          // Moeda do pedido (do header)
        grupoMateriais: sent.MATL_GROUP || '',                                          // Grupo de materiais
        categoriaItem: sent.ITEM_CAT || '',                                             // Categoria do item
        preqNo: sent.PREQ_NO || '',                                                     // Nº da requisição (se houver)
        preqItem: sent.PREQ_ITEM || ''                                                  // Item da requisição (se houver)
      };
    });
  };

  // ==== fluxo principal =====================================================
  const itensNorm = itensDoAriba.map(normalizarItem);                                // 1) Normaliza cada item do Ariba (aliases -> nomes esperados)
  const cabAdaptado = adaptarCabecalho(cabecalhoDoAriba || {});                        // 2) Adapta o header do Ariba para POHEADER (nomes SAP)
  validarObrigatorios(cabAdaptado, itensNorm);                                         // 3) Valida header+itens (fail-fast antes de chamar a BAPI)
  const payload = montarPayload(cabAdaptado, itensNorm);                           // 4) Monta o payload da BAPI (POHEADER/POITEM + X + TESTRUN)

  const bapi = await cds.connect.to('BAPI_PO_CREATE');                                // 5) Conecta no destino remoto configurado (ex.: RFC/SOAP/OData)
  const bruto = await bapi.send({ action: 'BAPI_PO_CREATE1', data: payload });         // 6) Chama a action BAPI_PO_CREATE1 com o payload montado

  const RETURN = paraArray(bruto?.RETURN?.item || bruto?.RETURN);                 // Normaliza mensagens de retorno (S/W/E/A)
  const POCOND = paraArray(bruto?.POCOND?.item || bruto?.POCOND);                 // Normaliza tabela de condições (para somar impostos)
  const POITEM_echo = paraArray(bruto?.POITEM?.item || bruto?.POITEM);                 // Normaliza eco de itens (SHORT_TEXT etc.)

  const success = !RETURN.some(m => m.TYPE === 'E' || m.TYPE === 'A');                // Considera sucesso se não houver mensagem de erro/abort
  const messages = RETURN.map(m => ({ type: m.TYPE, text: m.MESSAGE }));               // Converte mensagens em {type, text} para a UI
  const tabelaItens = montarTabelaItensParaFront({ payload, cabecalho: cabAdaptado, POCOND, POITEM_echo }); // Monta tabela amigável para o front

  return { success, messages, purchaseOrder: bruto?.EXPPURCHASEORDER || null, tabelaItens }; // Em TESTRUN, purchaseOrder geralmente vem null
}

module.exports = { simularPO }; // Exporta apenas a função principal para ser usada no handler do serviço
