# THE AUCTION POKER 運営アプリ

頭脳戦「THE AUCTION POKER」の当日の進行を回すページ。GM・会場画面・プレイヤーの三つの画面を、Firebase(Firestore)で同期する。

- プレイヤーはページを開いて、座席札の参加コードを入れるだけ(ログインは要らない)。
- GMは、GMとして登録した Google アカウントでログインする。
- 配札表はこのリポジトリに置かない。GMの画面で一度読み込むと、GMだけが読める所に保存される。

## 置き方

1. Firebase のプロジェクトで、Authentication の「匿名」と「Google」を有効にし、承認済みドメインにこのページのドメインを足す。
2. Firestore Database を作り、`firestore.rules` の GMのメールアドレスを書き換えて、ルールに貼って公開する。
3. `config.js` を、Firebase のコンソールに出る `const firebaseConfig = { … };` の一文に置き換える。
4. GitHub Pages で公開する。

config.js が null のままだと「この端末だけ」で動く(稽古用)。
