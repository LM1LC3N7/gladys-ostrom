# Ostrom

Intégration non officielle pour les clients d'électricité d'**Ostrom** en
Allemagne, sans lien avec Ostrom. Elle lit vos propres données par l'API
officielle d'Ostrom. **Lecture seule** : rien n'est jamais modifié sur votre
compte.

> Cette intégration n'a jamais été testée avec un vrai compte Ostrom : elle a
> été écrite d'après la documentation officielle de l'API. Merci de signaler ce
> que vous voyez (issues GitHub de LM1LC3N7/gladys-ostrom).

## Ce que vous obtenez

- **Un appareil par contrat Ostrom** (nommé « Ostrom électricité (contrat
  …1234) », les 4 derniers chiffres du numéro de contrat) :
  - **Consommation (30 min)** : la consommation du compteur communicant,
    publiée après coup pour le suivi énergétique de Gladys. Ostrom donne des
    heures : chaque heure est coupée en deux moitiés égales. Seulement avec un
    compteur communicant (iMSys) qui envoie ses relevés à Ostrom.
  - Pour un contrat **SimplyDynamic** seulement : **Prix du kWh actuel**,
    **Prochain prix du kWh** (EUR/kWh, taxes, prélèvements, frais de réseau
    variables et TVA inclus, chaque quart d'heure) et **Frais de base et de
    réseau par mois** (EUR, TVA incluse).
- **Le modèle de contrat d'énergie « Ostrom SimplyDynamic »** : Gladys demande
  à l'intégration le coût de chaque demi-heure ; elle répond avec la moyenne
  des deux prix au quart d'heure de votre code postal multipliée par la
  consommation. Une demi-heure dont le prix moyen est négatif coûte 0 (Gladys
  n'accepte pas de coût négatif) : le coût affiché par Gladys dépasse alors
  votre facture du crédit accordé par Ostrom, s'il en accorde un. Les frais mensuels sont un montant fixe que vous saisissez dans le
  contrat.

## Mise en route

1. Connectez-vous à l'**Ostrom Developer Portal**
   (https://developer.ostrom-api.io) avec le compte de votre application
   Ostrom.
2. Créez un **client d'API** pour l'environnement de **production** et
   acceptez le consentement développeur. Copiez son **identifiant client** et
   son **secret client**.
3. Dans Gladys, ouvrez la **Configuration** de l'intégration, collez les deux,
   gardez **Environnement : Production** et enregistrez. **Tester la
   connexion** obtient un jeton et compte vos contrats.
4. Dans **Découverte**, ajoutez l'appareil de votre contrat.
5. Pour un contrat SimplyDynamic : dans les réglages d'énergie, créez un
   contrat depuis le modèle **Ostrom SimplyDynamic**, rattaché à la
   consommation de cet appareil. Laissez « 4 derniers chiffres du contrat
   Ostrom » vide si vous avez un seul contrat ; saisissez-les si vous en avez
   plusieurs. Saisissez les frais mensuels affichés par la fonctionnalité
   « Frais de base et de réseau par mois ».

Le secret client est gardé par Gladys dans sa base, jamais réaffiché et envoyé
seulement à Ostrom pour obtenir un jeton d'accès (valable une heure, gardé en
mémoire seulement). L'environnement **Bac à sable** ne sert qu'à un client
d'API créé pour le bac à sable d'Ostrom (données de test).

## À quel rythme elle lit

- Les contrats : toutes les 6 heures.
- Les prix passés manquants (après un arrêt, une panne) : jusqu'à 31 jours en
  arrière, au plus toutes les 6 heures.
- Les prix : quand ceux qu'elle a ne couvrent pas la fin de la journée (ou,
  dès 15 h heure allemande, quand Ostrom les charge, toute la journée de
  demain), au plus une fois par heure. Une fois demain connu, plus rien avant
  15 h le lendemain.
- La consommation des appareils ajoutés : toutes les 3 heures (les 3 derniers
  jours), une fois par jour après 6 h et pour un nouvel appareil les 7
  derniers jours.
- Après une lecture des contrats en échec : de nouveau après 5, 10, 20, 40
  puis toutes les 60 minutes. Ostrom qui demande de ralentir (HTTP 429) ou
  indisponible (5xx) : aucune requête jusqu'à l'heure demandée (au moins
  1 minute, au plus 6 heures), gardée d'un redémarrage à l'autre.
- Un redémarrage, la Découverte ou l'enregistrement de la configuration ne
  lisent jamais plus tôt que ces intervalles (de nouveaux identifiants sont
  lus après 1 minute).

## Ce que sont les prix

Pour chaque quart d'heure, l'API des prix d'Ostrom donne, pour votre code
postal, le prix spot day-ahead avec TVA et les taxes, prélèvements et frais de
réseau variables avec TVA, en centimes. L'intégration additionne les deux et
divise par 100. Les prix des quarts d'heure passés sont gardés 40 jours dans
`/data`, pour que Gladys puisse tarifer les intervalles passés : créez le
contrat à partir du jour où vous installez l'intégration.

Non inclus : un tarif de réseau variable §14a (module 3), une remise ou un
bonus de votre contrat. Jamais de prix deviné ni de prix nul : quand un seul
prix au quart d'heure d'une période manque, toute la demande de Gladys pour
cette période de facturation échoue, et aucun coût n'est gardé tant que le
prix n'est pas connu. L'intégration relit donc les quarts d'heure passés sans
prix (jusqu'à 31 jours en arrière, au plus toutes les 6 heures), par exemple
après un arrêt de Gladys ; un prix qu'Ostrom ne donne jamais laisse ces coûts
vides.

## Messages

- _Ostrom a refusé l'identifiant client ou le secret client_ : le point de
  jeton a répondu `invalid_client` ou `unauthorized_client`. Rien n'est renvoyé
  tant que vous ne changez pas les identifiants ou que le bouton **Tester** ne
  réussit pas. Toute autre erreur (une réponse illisible, un 401 ou 403 d'une
  requête de données, un 5xx) n'est jamais prise pour un refus.
- _ni taxes ni frais de réseau pour le code postal_ : Ostrom a répondu des prix
  sans taxes pour le code postal de votre contrat ; ces prix ne sont pas les
  vôtres et ne sont pas gardés (redemandés toutes les 6 heures).
- _Ostrom n'a donné aucun prix pour certains jours passés_ : les jours passés
  (jusqu'à 31 jours en arrière) n'ont pas pu être complétés, par exemple parce
  qu'Ostrom ne sert pas les prix passés. Les prix d'aujourd'hui et de demain ne
  sont pas touchés ; les coûts de la période de facturation de ces jours
  restent vides (redemandés toutes les 6 heures).
- _Un contrat dynamique n'a pas de code postal lisible_ : ses prix ne peuvent
  pas être lus.

## Vie privée

Votre numéro de contrat, votre nom, votre adresse et votre code postal ne sont
jamais écrits dans un journal, le statut ni `/data` : un contrat est connu par
une empreinte à clé et ses 4 derniers chiffres. `/data` garde l'heure des
dernières lectures, la pause, les prix des quarts d'heure passés et une marque
des identifiants refusés (8 bits d'une empreinte salée, rien pour les
retrouver).
