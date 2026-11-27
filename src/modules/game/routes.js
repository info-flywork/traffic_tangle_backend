'use strict';

const { defineModule } = require('../../core/route');
const { GetMeBootstrapResponse, ListMeProgressResponse, UpdateMeProgressBody, UpdateMeProgressResponse, CreateLevelsCompleteParams, CreateLevelsCompleteBody, CreateLevelsCompleteResponse, CreateWalletSpendBody, CreateWalletSpendResponse, CreateBoostersUseParams, CreateBoostersUseBody, CreateBoostersUseResponse, GetCityNextBuildingResponse, CreateBuildingsRenewParams, CreateBuildingsRenewBody, CreateBuildingsRenewResponse } = require('./schemas');

// Yollar Flutter'ın çağırdığıyla BİREBİR (sözleşme). Handler yalnızca servisi çağırır.
module.exports = defineModule('game', '', [
  {
    method: 'get',
    path: '/me/bootstrap',
    summary: 'Açılış verisi: ilerleme, sıradaki bina, premium',
    auth: 'required',
    response: GetMeBootstrapResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.getMeBootstrap(user, { ...params, ...query, ...body }),
  },
  {
    method: 'get',
    path: '/me/progress',
    summary: 'Oyuncu ilerlemesi (bakiye, açık bölümler, yenilenen binalar)',
    auth: 'required',
    response: ListMeProgressResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.listMeProgress(user, { ...params, ...query, ...body }),
  },
  {
    method: 'patch',
    path: '/me/progress',
    summary: 'Son oynanan bölüm ve tek yönlü bayraklar',
    auth: 'required',
    rateLimit: { windowMs: 60000, max: 60 },
    request: { body: UpdateMeProgressBody },
    response: UpdateMeProgressResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.updateMeProgress(user, { ...params, ...query, ...body }),
  },
  {
    method: 'post',
    path: '/levels/:number/complete',
    summary: 'Bölümü bitir: kırpma, ödül, ilerleme',
    auth: 'required',
    rateLimit: { windowMs: 60000, max: 30 },
    request: { params: CreateLevelsCompleteParams, body: CreateLevelsCompleteBody },
    response: CreateLevelsCompleteResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.createLevelsComplete(user, { ...params, ...query, ...body }),
  },
  {
    method: 'post',
    path: '/wallet/spend',
    summary: 'Coin harca (ipucu, renk kutusu, +süre, +hamle); fiyat sunucuda',
    auth: 'required',
    rateLimit: { windowMs: 60000, max: 60 },
    request: { body: CreateWalletSpendBody },
    response: CreateWalletSpendResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.createWalletSpend(user, { ...params, ...query, ...body }),
  },
  {
    method: 'post',
    path: '/boosters/:type/use',
    summary: 'Güçlendiriciyi stoktan kullan',
    auth: 'required',
    rateLimit: { windowMs: 60000, max: 60 },
    request: { params: CreateBoostersUseParams, body: CreateBoostersUseBody },
    response: CreateBoostersUseResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.createBoostersUse(user, { ...params, ...query, ...body }),
  },
  {
    method: 'get',
    path: '/city/next-building',
    summary: 'Sıradaki yenilenecek bina (yoksa null)',
    auth: 'required',
    response: GetCityNextBuildingResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.getCityNextBuilding(user, { ...params, ...query, ...body }),
  },
  {
    method: 'post',
    path: '/buildings/:id/renew',
    summary: 'Binayı yenile, ödülü ver',
    auth: 'required',
    rateLimit: { windowMs: 60000, max: 20 },
    request: { params: CreateBuildingsRenewParams, body: CreateBuildingsRenewBody },
    response: CreateBuildingsRenewResponse,
    handler: ({ user, params, query, body, deps }) => deps.game.createBuildingsRenew(user, { ...params, ...query, ...body }),
  },
]);
