// web/src/settings/secretLabels.ts：SecretName → i18n 标签键的**唯一映射**。
// 审计 P0-5：设置页曾把后端存储/env 名（TMDB_API_KEY、TRANSLATE_BASE_URL…）直接当
// 用户标签。存储名属于部署面，用户界面要的是"这是什么"的人话；这个文件收拢那份翻译，
// 让 ProviderCard / TranslateCard 不再各自持有 env 名副本。
import type { TKey } from '../i18n/useT.js'
import type { SecretName } from '../api/types.js'

export const SECRET_LABEL_KEY: Record<SecretName, TKey> = {
  TMDB_API_KEY: 'secret_tmdb_api_key',
  LLM_BASE_URL: 'wizard_llm_base_label',
  LLM_API_KEY: 'wizard_llm_key_label',
  LLM_MODEL: 'wizard_llm_model_label',
  ASSRT_TOKEN: 'secret_assrt_token',
  OPENSUBTITLES_API_KEY: 'secret_opensubtitles_api_key',
  OPENSUBTITLES_USERNAME: 'secret_opensubtitles_username',
  OPENSUBTITLES_PASSWORD: 'secret_opensubtitles_password',
  JIMAKU_API_KEY: 'secret_jimaku_api_key',
  R3SUB_EMAIL: 'secret_r3sub_email',
  R3SUB_PASSWORD: 'secret_r3sub_password',
  SUBDL_API_KEY: 'secret_subdl_api_key',
  TRANSLATE_BASE_URL: 'secret_translate_base_url',
  TRANSLATE_API_KEY: 'secret_translate_api_key',
  TRANSLATE_MODEL: 'secret_translate_model',
  ZIMUKU_VISION_BASE_URL: 'settings_zimuku_vision_base_url_label',
  ZIMUKU_VISION_API_KEY: 'settings_zimuku_vision_api_key_label',
  ZIMUKU_VISION_MODEL: 'settings_zimuku_vision_model_label',
}
