Bu maqola **Sozlamalar** bo‘limi ochiq bo‘lgan odamlar uchun.

Baza nusxasini tizim o‘zi oladi, har kecha. Nusxalarni ko‘rish va qo‘lda olish —
**Sozlamalar → Baza nusxalari**.

Tungi jadval sukut bo‘yicha yoqilgan: yangi serverda hech narsa sozlash kerak
emas, nusxalar o‘zi boshlanadi. Uni `BACKUP_SCHEDULER` o‘zgaruvchisi o‘chiradi —
o‘shanda ekran «Jadval: O‘chirilgan» deb to‘g‘ridan-to‘g‘ri aytadi va nusxa faqat
tugma bilan olinadi. Namoyish stendida jadval ataylab o‘chirilgan: u yerda
nusxalar saqlanmaydi.

## Sizdan so‘ramasdan nima bo‘ladi

1. Kechasi, odatda server vaqti bilan **03:20** da, tizim `pg_dump` ni ishga
   tushiradi va baza nusxasini shu serverdagi katalogga yozadi.
2. Nusxa siqiladi va `metall-asia-20261007-032000-412.dump` ko‘rinishidagi fayl
   bo‘lib yotadi. Nomning oxiri — nusxalar jurnalidagi yozuv raqami: shu raqam
   bo‘yicha fayl va jurnal satri bir-birini topadi.
3. Jurnalga boshlanish vaqti, qancha davom etgani, fayl vazni, uning `sha256` i va
   nima bilan tugagani yoziladi.
4. Keraksiz fayllar o‘chiriladi: diskda `BACKUP_KEEP` da ko‘rsatilgancha oxirgi
   nusxa turadi — sukut bo‘yicha **30 ta**. Nechta ekani ekrandagi «Saqlanadi»
   satrida yozilgan. Jurnal yozuvlari esa hammasi qoladi — ular bo‘yicha o‘sha
   kuni nusxa bo‘lgani ko‘rinadi.
5. Nusxa olinmasa, administratorga Telegram orqali sabab bilan xabar keladi. Bu
   oddiy bot xabari — qolgan [xabarlar](help:telegram) kabi uni o‘chirib qo‘yish
   mumkin, lekin o‘chirmang.

## «Baza nusxalari» ekrani

| Nimani ko‘rsatadi | Nima uchun |
| --- | --- |
| yuqoridagi holat satri | oxirgi tayyor nusxa qachon bo‘lgani; 30 soatdan ko‘p bo‘lsa — ogohlantirish. Jadval o‘chirilgan bo‘lsa ogohlantirish bo‘lmaydi: tungi nusxani kutadigan hech kim yo‘q |
| nusxalar ro‘yxati | qachon, qancha davom etgan, vazni, nima bilan tugagan, kim boshlagan |
| «Hozir nusxa olish» tugmasi | jadvaldan tashqari nusxa: yangilashdan oldin, ma’lumotni katta o‘zgartirishdan oldin |
| satrdagi «Yuklab olish» | nusxa faylini o‘zingizga olish; siqib chiqarilganlarda tugma yo‘q — fayl ham yo‘q |

Nusxa o‘n-yigirma soniya davom etadi va odamlarning ishiga oddiy hisobotdan ko‘p
xalaqit bermaydi. «Hozir nusxa olish» ni ish vaqtida bosish mumkin.

## Nusxalar qayerda yotadi

Stend serverida bu `dev/backend/var/backups-stand` katalogi. Disk baza yonida, va
kuchsiz joyi shunda: yong‘in, o‘g‘irlik yoki disk nosozligi bazani nusxalar bilan
birga olib ketadi. Shuning uchun haftada bir marta oxirgi nusxani «Yuklab olish»
tugmasi bilan olib, boshqa mashinada saqlang. O‘z serveringizga ko‘chganda
nusxalarga alohida disk ajratib qo‘ying.

## Serverdagi sozlamalar

Xizmatning muhit faylida beriladi; nima chiqqanini tizim ekranda ko‘rsatadi.

| O‘zgaruvchi | Nimani bildiradi | Odatdagi qiymat |
| --- | --- | --- |
| `BACKUP_DATABASE_URL` | `pg_dump` uchun baza manzili, sxema egasi roli bilan | majburiy, u bo‘lmasa nusxa olinmaydi |
| `BACKUP_DIR` | nusxalar yoziladigan katalog | `./var/backups` |
| `BACKUP_AT` | tungi ishga tushish vaqti, `SS:MM` | `03:20` |
| `BACKUP_KEEP` | diskda qancha nusxa turadi | `30` |
| `BACKUP_PG_DUMP` | `pg_dump` ni nima bilan chaqirish | `pg_dump` |
| `BACKUP_SCHEDULER` | `off` jadvalni o‘chiradi | yoniq |

`BACKUP_DATABASE_URL` sxema egasi roliga ko‘rsatishi shart. Amaliy rol bilan
`pg_dump` himoyalangan jadvallarni **bo‘sh** holda chiqaradi va bu haqda aytmaydi:
chiqish kodi nol, fayl joyida, vazni ishonchli. Shuning uchun manzil ishchi
manzildan alohida beriladi, u bo‘lmasa tizim nusxani umuman olmaydi.

## Bazani nusxadan qanday tiklash kerak

Tizimda «Tiklash» tugmasi yo‘q, va bu qaror, kamchilik emas: brauzerdagi bunday
tugma administrator sessiyasini qo‘lga olgan har qanday odam uchun «hamma
ma’lumotni o‘chirish» degani. Tiklash serverda qo‘lda, shu tartibda qilinadi.

1. Bazaga hech kim yozmasligi uchun tizim xizmatini to‘xtating:
   `systemctl --user stop metall-asia-stand-api`.
2. Nusxani **yangi bazaga** yoying, ishchi bazaga emas:

```
createdb -U postgres -O metall_owner metall_asia_restore
pg_restore -U postgres -d metall_asia_restore \
  --no-owner --no-privileges --exit-on-error \
  metall-asia-20261007-032000-412.dump
```

3. Yangi bazadagi yozuvlar sonini kutgan son bilan solishtiring — hech bo‘lmasa
   ombor, buyurtmalar va moliya bo‘yicha:

```
psql -U postgres -d metall_asia_restore -c \
  "select count(*) from stock_move; select count(*) from sales_order;"
```

4. Faqat shundan keyin tizimni tiklangan bazaga ulang: xizmat muhit faylidagi
   `APP_DATABASE_URL` manzilidagi baza nomini o‘zgartirib, xizmatni ishga tushiring.
5. Eski bazani bir hafta o‘chirmang: tiklangan bazada biror narsa yetmasa,
   solishtirish uchun nimadir qolsin.

Baza konteynerda bo‘lsa, shu buyruqlar uning orqali ketadi, nusxa fayli esa oqim
bilan beriladi: `docker exec -i -e PGPASSWORD metall-asia-postgres pg_restore … < fayl.dump`.

> **Nusxani ishchi bazaning ustiga yoymang.** Bazani qaytadan ekish barcha
> hisoblarning parollarini tashlab yuboradi va tizim unda ishlagan hammaga yopiq
> bo‘lib qoladi. 2- va 4-qadam aynan shuning uchun ajratilgan: avval yangi baza,
> keyin ulash.

## Oyda bir marta nusxa tirikligini tekshiring

Hech kim yoymagan nusxa — fayl, nusxa emas. Tekshiruv shu qadamlarning o‘zi, lekin
xizmatni to‘xtatmasdan: oxirgi nusxani alohida bazaga yoyish, yozuvlar sonini ishchi
baza bilan solishtirish, vaqtinchalik bazani o‘chirish. Loyihada buning uchun tayyor
skript bor — uni serverni yuritadigan odamlardan so‘rang.

## Nusxa nimani qamrab olmaydi

| Nima | Qayerda yashaydi | Baza nusxasida |
| --- | --- | --- |
| tizim ma’lumotlari | PostgreSQL bazasi | ha, nusxaning o‘zi shu |
| yuklangan fayllar va ilovalar | serverdagi fayllar katalogi | yo‘q, alohida nusxalanadi |
| kod va yig‘ma | git-repozitoriy | kerak emas, [yangilash](help:admin-vykatka) bilan tiklanadi |
| xizmatning muhit fayli | server | yo‘q, nusxasini alohida va yopiq saqlang |

Ilovalar baza dampiga tushmaydi: ular diskdagi fayllar. Katalogi xizmat
sozlamalarida ko‘rsatilgan, uni ham baza bilan bir tartibda nusxalang.
