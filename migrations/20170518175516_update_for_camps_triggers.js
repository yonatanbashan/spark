exports.up = function (knex, Promise) {
  return Promise.all([
    knex.schema.table('tickets', function (table) {
      table.renameColumn('disabledParking', 'disabled_parking');
    }),

    knex('users_groups_membership', table => {
      table.enu('status', constants.CAMP_MEMBER_STATUS);
    }).then(
      knex.raw('DROP TRIGGER IF EXISTS camp_members_groups_after_upd').then(
        knex.raw('CREATE TRIGGER camp_members_groups_after_upd AFTER UPDATE ON camp_members ' +
          'FOR EACH ROW ' +
          'UPDATE users_groups_membership SET status = new.status WHERE group_id = new.camp_id AND user_id = new.user_id '
        ).then(
          knex.raw('insert into users_groups_membership(user_id, group_id, status) ' +
            'select cm.user_id, cm.camp_id, cm.status ' +
            'from users u ' +
            'inner join camp_members cm on u.user_id = cm.user_id ' +
            'ON DUPLICATE KEY UPDATE status = cm.status;')
        )
      )
    )
  ]);
};

exports.down = function (knex, Promise) {
    return Promise.all([]);
};
